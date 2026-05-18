/**
 * research_py provider — tier_2, local gpt-researcher sidecar.
 *
 * Wraps `services/research-py` via the existing
 * `@founder-os/research-runner` HTTP client. Per spec §6 this channel is
 * the orchestrator's "tier_2 backstop" when the three subscription
 * channels are down, and is also the canonical competitor-scan channel.
 *
 * Flow per topic:
 *   1. POST /research/deep with { venture_slug, topic, depth }.
 *   2. Poll /research/jobs/<id> until done / error / timeout.
 *   3. Read the markdown report from `result.output_path` on the local
 *      filesystem.
 *   4. Run the shared paste-in parser to convert the markdown into a
 *      ProviderPartial. Stamp `result.sources` (URLs the researcher
 *      actually fetched) on top of whatever the parser extracted — those
 *      are first-party provenance, more trustworthy than text scraping.
 *
 * NODE-ONLY — step 3 reads the report file via node:fs. The Tauri WebView
 * reaches this provider through the Node-side bridge.
 */

import { readFile } from "node:fs/promises";
import {
  parsePastedDeepResearch,
  type ProviderPartial,
  type ResearchProvider,
  type ResearchTopicOpts,
  type Source,
} from "@founder-os/research-deep-core";
import {
  pollJob,
  ResearchClient,
  ResearchClientError,
  type DeepResearchResult,
  type JobRecord,
  type PollJobOptions,
} from "@founder-os/research-runner";

export interface CreateResearchPyProviderOpts {
  /**
   * Either an existing ResearchClient OR a baseUrl to construct one with.
   * Tests pass a fully-mocked client; production passes the URL from
   * Tauri config.
   */
  client?: ResearchClient;
  baseUrl?: string;
  /**
   * Required: the venture slug the orchestrator is researching. The
   * sidecar uses this for output directory + job tagging.
   */
  ventureSlug: string;
  /**
   * gpt-researcher `depth` parameter (1-5). >=4 upgrades report_type to
   * "deep" server-side. Default 3 (balanced quality / time / cost).
   */
  depth?: number;
  /**
   * Total time to wait for a single topic. Default: 20 min (deep-mode
   * gpt-researcher runs can be slow; the sidecar caps each at ~15min).
   */
  jobTimeoutMs?: number;
  /**
   * Poll interval. Default 3s — matches the existing pollJob default.
   */
  pollIntervalMs?: number;
  /**
   * Inject a custom file reader. Default: node:fs/promises readFile. Tests
   * pass a stub so they never touch the disk.
   */
  readReport?: (path: string) => Promise<string>;
  /**
   * Override availability probe. Default: `client.health()` succeeds.
   */
  isAvailable?: () => Promise<boolean>;
}

export class ResearchPyInvocationError extends Error {
  /** "rejected" (HTTP), "timeout", "errored" (job marked status=error), "aborted", "read-failed". */
  readonly stage: "rejected" | "timeout" | "errored" | "aborted" | "read-failed";
  constructor(
    stage: "rejected" | "timeout" | "errored" | "aborted" | "read-failed",
    cause: string,
  ) {
    super(`research_py: ${cause}`);
    this.name = "ResearchPyInvocationError";
    this.stage = stage;
  }
}

/**
 * Build a `research_py`-channel `ResearchProvider`. Available when the
 * sidecar's /health endpoint responds 2xx. Sources tagged
 * `retrievedBy: "research_py"`; trust tier defaults to secondary since
 * gpt-researcher fetches the pages itself (more trustworthy than scraping
 * paste-in text).
 */
export function createResearchPyProvider(
  opts: CreateResearchPyProviderOpts,
): ResearchProvider {
  if (!opts.ventureSlug || !opts.ventureSlug.trim()) {
    throw new Error(
      "createResearchPyProvider: opts.ventureSlug is required",
    );
  }

  const client =
    opts.client ?? (opts.baseUrl ? new ResearchClient({ baseUrl: opts.baseUrl }) : null);
  if (!client) {
    throw new Error(
      "createResearchPyProvider: pass either opts.client or opts.baseUrl",
    );
  }

  const depth = opts.depth ?? 3;
  const jobTimeoutMs = opts.jobTimeoutMs ?? 20 * 60_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 3000;
  const readReport = opts.readReport ?? defaultReadReport;
  const isAvailable = opts.isAvailable ?? defaultHealthProbe(client);

  return {
    name: "research_py",

    async available(): Promise<boolean> {
      try {
        return await isAvailable();
      } catch {
        return false;
      }
    },

    async researchTopic(topicOpts: ResearchTopicOpts): Promise<ProviderPartial> {
      const accessedAt = topicOpts.accessedAt ?? new Date().toISOString();

      // 1. Kick off the deep research job. The sidecar takes the topic as
      //    a free-text string; we prepend the venture context as
      //    parenthetical scope so gpt-researcher's planner can use it.
      let acceptance;
      try {
        acceptance = await client.createDeepResearch({
          venture_slug: opts.ventureSlug,
          topic: buildSidecarTopic(topicOpts),
          depth,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ResearchPyInvocationError("rejected", `createDeepResearch failed: ${msg}`);
      }

      // 2. Poll until terminal.
      const pollOpts: PollJobOptions = {
        intervalMs: pollIntervalMs,
        timeoutMs: jobTimeoutMs,
      };
      if (topicOpts.signal) pollOpts.signal = topicOpts.signal;

      const outcome = await pollJob(client, acceptance.job_id, pollOpts);

      if (outcome.kind === "timeout") {
        throw new ResearchPyInvocationError(
          "timeout",
          `job ${acceptance.job_id} did not finish within ${jobTimeoutMs}ms`,
        );
      }
      if (outcome.kind === "aborted") {
        throw new ResearchPyInvocationError("aborted", `job ${acceptance.job_id} aborted`);
      }
      if (outcome.kind === "error") {
        const errMsg = outcome.record.error ?? "(no error message)";
        throw new ResearchPyInvocationError("errored", errMsg);
      }

      const result = outcome.record.result as DeepResearchResult | null;
      if (!result || !result.output_path) {
        throw new ResearchPyInvocationError(
          "errored",
          `job ${acceptance.job_id} completed without an output_path`,
        );
      }

      // 3. Read the markdown report from disk.
      let markdown: string;
      try {
        markdown = await readReport(result.output_path);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ResearchPyInvocationError(
          "read-failed",
          `could not read ${result.output_path}: ${msg}`,
        );
      }

      // 4. Parse + fold first-party sources on top.
      const partial = parsePastedDeepResearch(markdown, {
        channel: "research_py",
        accessedAt,
        expectedQuestions: topicOpts.questions.map((q) => q.question),
      });

      const firstParty = (result.sources ?? []).map(
        (url): Source => ({
          url,
          title: hostnameOf(url),
          accessedAt,
          retrievedBy: "research_py",
          trustTier: "secondary",
        }),
      );
      const sources = mergeSources(partial.sources, firstParty);

      return {
        ...partial,
        sources,
        rawTranscript: {
          channel: "research_py",
          jobId: acceptance.job_id,
          jobRecord: outcome.record satisfies JobRecord,
          markdown,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function buildSidecarTopic(opts: ResearchTopicOpts): string {
  // gpt-researcher uses the topic as a free-text query — embed the
  // questions list inline so the planner sees them, but keep the topic
  // label first so its own headings still group sensibly.
  const ctx = opts.ventureContext?.trim() ? `\n\nVenture context: ${opts.ventureContext.trim()}` : "";
  const qs = opts.questions
    .map((q, i) => `${i + 1}. ${q.question}`)
    .join("\n");
  return `${opts.topic.label}\n\nResearch questions:\n${qs}${ctx}`;
}

function defaultHealthProbe(client: ResearchClient): () => Promise<boolean> {
  return async () => {
    try {
      await client.health();
      return true;
    } catch (err) {
      // Network failures (sidecar not running) → not available. Anything
      // else (non-2xx with a body) → still not available, just typed.
      void (err instanceof ResearchClientError);
      return false;
    }
  };
}

async function defaultReadReport(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function mergeSources(parsed: Source[], firstParty: Source[]): Source[] {
  const byUrl = new Map<string, Source>();
  for (const s of parsed) byUrl.set(s.url, s);
  // First-party URIs (URLs gpt-researcher actually fetched) win — they're
  // attested provenance, not regex-extracted from prose.
  for (const s of firstParty) byUrl.set(s.url, s);
  return Array.from(byUrl.values());
}
