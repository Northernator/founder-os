/**
 * Deep Research stage helper.
 *
 * This is a cross-cutting vault writer, not a new pipeline stage. The warm-up
 * runner owns RESEARCH-stage logs/artifact-index entries while the helper can
 * be called by later runners for topic top-ups.
 */
import type { ArtifactIndexEntry, StageRunResult, ValidationResult, VentureManifest } from "@founder-os/domain";
import {
  DEFAULT_MAX_COST_GBP_PER_TOPIC,
  DEFAULT_MAX_COST_GBP_PER_WARM_UP,
  DEFAULT_RESEARCH_CHANNELS,
  DEFAULT_STALE_AFTER_DAYS,
  DEEP_RESEARCH_BRIEFINGS_DIR_NAME,
  DEEP_RESEARCH_CHECKPOINT_FILE_NAME,
  DEEP_RESEARCH_DIR_NAME,
  DEEP_RESEARCH_PLAN_FILE_NAME,
  DEEP_RESEARCH_SOURCES_DIR_NAME,
  DEEP_RESEARCH_SOURCES_INDEX_FILE_NAME,
  DEEP_RESEARCH_TRANSCRIPTS_DIR_NAME,
  ResearchBriefingSchema,
  ResearchPlanSchema,
  emitSourcedSectionsMarkdown,
  type CallLlm,
  type ResearchBriefing,
  type ResearchChannel,
  type ResearchPlan,
  type ResearchPlanTopic,
  type ResearchProvider,
  type ResearchQuestion,
  type RequestPasteIn,
} from "@founder-os/research-deep-core";
import type {
  OrchestrateProgress,
  OrchestrateTopicResult,
} from "@founder-os/research-deep-orchestrator";
import { orchestrateTopic } from "@founder-os/research-deep-orchestrator";
import type { Filesystem } from "@founder-os/pipeline-runner";
import { BaseStageRunner } from "./runner-base.js";
import type { StageRunner } from "./types.js";

export interface DeepResearchTopicSeed {
  slug: string;
  label: string;
  questions: ResearchQuestion[];
  consumers?: string[];
  staleAfterDays?: number;
}

export const DEFAULT_DEEP_RESEARCH_TOPIC_SEEDS: readonly DeepResearchTopicSeed[] = [
  {
    slug: "market-landscape",
    label: "Market landscape",
    consumers: ["RESEARCH", "VALIDATION", "BRAND"],
    questions: [
      {
        id: "q-market-size",
        question: "What is the current market size, growth direction, and buyer urgency for this venture?",
        angle: "market",
        priority: "must",
      },
      {
        id: "q-market-trends",
        question: "Which recent trends or structural changes make this opportunity better or worse now?",
        angle: "market",
        priority: "should",
      },
    ],
  },
  {
    slug: "customer-problems",
    label: "Customer problems and willingness to pay",
    consumers: ["RESEARCH", "VALIDATION", "PRODUCT_SPEC"],
    questions: [
      {
        id: "q-customer-pain",
        question: "Who has the strongest pain, what triggers purchase intent, and what alternatives do they use?",
        angle: "customer",
        priority: "must",
      },
      {
        id: "q-wtp",
        question: "What evidence exists for willingness to pay and preferred pricing models?",
        angle: "financial",
        priority: "must",
      },
    ],
  },
  {
    slug: "competitor-baseline",
    label: "Competitor baseline",
    consumers: ["RESEARCH", "BRAND", "PRODUCT_SPEC"],
    questions: [
      {
        id: "q-competitors",
        question: "Which direct and indirect competitors matter most, and where are their visible gaps?",
        angle: "competitor",
        priority: "must",
      },
      {
        id: "q-positioning",
        question: "What positioning angles appear underserved by existing competitors?",
        angle: "competitor",
        priority: "should",
      },
    ],
  },
];

export interface GatherDeepResearchOpts {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
  topic: { slug: string; label: string };
  questions: ReadonlyArray<ResearchQuestion>;
  ventureContext: string;
  callLlm: CallLlm;
  plannerCallLlmChain?: ReadonlyArray<CallLlm>;
  workers?: ReadonlyArray<ResearchProvider>;
  requestPaste?: RequestPasteIn;
  maxCostGBP?: number;
  projectedCostGBP?: number;
  staleAfterDays?: number;
  consumers?: string[];
  runId?: string;
  force?: boolean;
  now?: string;
  onProgress?: (event: OrchestrateProgress) => void;
}

export interface GatherDeepResearchResult {
  briefing: ResearchBriefing;
  fromCache: boolean;
  artifactsCreated: string[];
  transcripts: OrchestrateTopicResult["transcripts"] | null;
}

export type DeepResearchPasteInStatus = {
  channel: ResearchChannel;
  topicSlug: string;
  topicLabel: string;
  promptPath: string;
  responsePath: string;
  status: "pending" | "pasted";
  updatedAt: string;
};

export type DeepResearchStageRunnerOpts = {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
  intake: string;
  callLlm: CallLlm;
  plannerCallLlmChain?: ReadonlyArray<CallLlm>;
  workers?: ReadonlyArray<ResearchProvider>;
  requestPaste?: RequestPasteIn;
  topicSeeds?: ReadonlyArray<DeepResearchTopicSeed>;
  maxCostGBPPerWarmUp?: number;
  estimatedCostGBPPerTopic?: number;
  runId?: string;
};

export class DeepResearchCostCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeepResearchCostCapError";
  }
}

export class DeepResearchStageRunner extends BaseStageRunner implements StageRunner {
  readonly stageName = "RESEARCH" as const;
  private readonly intake: string;
  private readonly callLlm: CallLlm;
  private readonly plannerCallLlmChain: ReadonlyArray<CallLlm> | undefined;
  private readonly workers: ReadonlyArray<ResearchProvider> | undefined;
  private readonly requestPaste: RequestPasteIn | undefined;
  private readonly topicSeeds: ReadonlyArray<DeepResearchTopicSeed>;
  private readonly maxCostGBPPerWarmUp: number;
  private readonly estimatedCostGBPPerTopic: number;

  constructor(opts: DeepResearchStageRunnerOpts) {
    super(opts.ventureRoot, opts.fs, opts.manifest, opts.runId);
    this.intake = opts.intake;
    this.callLlm = opts.callLlm;
    this.plannerCallLlmChain = opts.plannerCallLlmChain;
    this.workers = opts.workers;
    this.requestPaste = opts.requestPaste;
    this.topicSeeds = opts.topicSeeds ?? DEFAULT_DEEP_RESEARCH_TOPIC_SEEDS;
    this.maxCostGBPPerWarmUp = opts.maxCostGBPPerWarmUp ?? DEFAULT_MAX_COST_GBP_PER_WARM_UP;
    this.estimatedCostGBPPerTopic = opts.estimatedCostGBPPerTopic ?? DEFAULT_MAX_COST_GBP_PER_TOPIC;
  }

  async validate(): Promise<ValidationResult> {
    const errors: string[] = [];
    const missingResources: string[] = [];
    if (!this.manifest.slug.trim()) errors.push("manifest.slug is required for deep research");
    if (!this.manifest.name.trim()) errors.push("manifest.name is required for deep research");
    if (!this.intake.trim()) missingResources.push("intake transcript");
    if (typeof this.callLlm !== "function") missingResources.push("LLM caller");
    if (this.topicSeeds.length === 0) errors.push("at least one deep-research topic seed is required");
    return {
      valid: errors.length === 0 && missingResources.length === 0,
      errors,
      missingResources,
    };
  }

  async run(): Promise<StageRunResult> {
    this.log("info", "deep-research warm-up starting", {
      runId: this.runId,
      topicCount: this.topicSeeds.length,
    });
    const artifactsCreated: string[] = [];

    try {
      const projected = this.topicSeeds.length * this.estimatedCostGBPPerTopic;
      if (projected > this.maxCostGBPPerWarmUp) {
        throw new DeepResearchCostCapError(
          `Deep research warm-up projected GBP ${projected.toFixed(2)} exceeds cap GBP ${this.maxCostGBPPerWarmUp.toFixed(2)}`
        );
      }

      for (const seed of this.topicSeeds) {
        this.log("info", "deep-research topic starting", { topicSlug: seed.slug });
        const result = await gatherDeepResearch({
          manifest: this.manifest,
          ventureRoot: this.ventureRoot,
          fs: this.fs,
          topic: { slug: seed.slug, label: seed.label },
          questions: seed.questions,
          consumers: seed.consumers,
          staleAfterDays: seed.staleAfterDays,
          ventureContext: this.intake,
          callLlm: this.callLlm,
          plannerCallLlmChain: this.plannerCallLlmChain,
          workers: this.workers,
          requestPaste: this.requestPaste,
          maxCostGBP: this.estimatedCostGBPPerTopic,
          projectedCostGBP: this.estimatedCostGBPPerTopic,
          runId: this.runId,
          onProgress: (event) => {
            this.log(event.phase === "cross-reference-degraded" ? "warn" : "info", event.phase, {
              topicSlug: event.topicSlug,
            });
          },
        });
        artifactsCreated.push(...result.artifactsCreated);
        this.log(result.fromCache ? "info" : "info", result.fromCache ? "deep-research topic cache-hit" : "deep-research topic ready", {
          topicSlug: seed.slug,
          sectionCount: result.briefing.sections.length,
          sourceCount: result.briefing.sources.length,
        });
      }

      const checkpointPath = getDeepResearchCheckpointPath(this.ventureRoot);
      await this.fs.writeFile(
        checkpointPath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            stage: "RESEARCH",
            kind: "deep-research-warm-up",
            runId: this.runId,
            ventureSlug: this.manifest.slug,
            topicCount: this.topicSeeds.length,
            completedAt: new Date().toISOString(),
          },
          null,
          2
        )}\n`
      );
      artifactsCreated.push(checkpointPath);
      await this.appendArtifactIndex(buildArtifactIndexEntries(this.runId, artifactsCreated));
      this.log("info", "deep-research checkpoint written", { path: checkpointPath });
      this.log("info", "deep-research warm-up finished", { artifactsCreated: artifactsCreated.length });

      return {
        success: true,
        stageName: this.stageName,
        runId: this.runId,
        artifactsCreated,
        logs: [...this.logs],
        requiresReview: false,
        nextStageReady: true,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log("error", "deep-research warm-up failed", { error: message });
      return {
        success: false,
        stageName: this.stageName,
        runId: this.runId,
        artifactsCreated,
        logs: [...this.logs],
        requiresReview: false,
        nextStageReady: false,
        error: {
          code: err instanceof DeepResearchCostCapError ? "DEEP_RESEARCH_COST_CAP" : "DEEP_RESEARCH_WARM_UP_FAILED",
          message,
          recoverable: true,
        },
      };
    } finally {
      try {
        await this.flushLogs();
      } catch (flushErr) {
        const msg = flushErr instanceof Error ? flushErr.message : String(flushErr);
        console.warn(`stage-runners: log flush failed for RESEARCH ${this.runId}: ${msg}`);
      }
    }
  }
}

export async function gatherDeepResearch(opts: GatherDeepResearchOpts): Promise<GatherDeepResearchResult> {
  const now = opts.now ?? new Date().toISOString();
  const staleAfterDays = opts.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  assertCostCap(opts.projectedCostGBP ?? 0, opts.maxCostGBP ?? DEFAULT_MAX_COST_GBP_PER_TOPIC);

  const cached = opts.force === true ? null : await readFreshCachedBriefing(opts, now, staleAfterDays);
  if (cached !== null) {
    return { briefing: cached, fromCache: true, artifactsCreated: [], transcripts: null };
  }

  const topicForPlan: ResearchPlanTopic = {
    slug: opts.topic.slug,
    label: opts.topic.label,
    questions: [...opts.questions],
    status: "running",
    consumers: opts.consumers ?? [],
  };
  await upsertPlanTopic(opts, topicForPlan, now);

  try {
    const requestPaste = opts.requestPaste ?? createFilesystemPasteInRequest(opts.fs, opts.ventureRoot, now);
    const result = await orchestrateTopic({
      topic: opts.topic,
      ventureSlug: opts.manifest.slug,
      ventureContext: opts.ventureContext,
      seedQuestions: opts.questions,
      plannerCallLlmChain: opts.plannerCallLlmChain ?? [opts.callLlm],
      workers: opts.workers ?? (await createDefaultWorkers(opts.callLlm, requestPaste)),
      crossReferenceCallLlm: opts.callLlm,
      synthesiserCallLlm: opts.callLlm,
      accessedAt: now,
      generatedAt: now,
      staleAfterDays,
      onProgress: opts.onProgress,
    });

    const paths = await persistDeepResearchRun(opts, result, opts.runId ?? shortRunId(now));
    await upsertPlanTopic(
      opts,
      {
        ...topicForPlan,
        status: "ready",
        lastRunAt: now,
        lastError: undefined,
      },
      now
    );
    return { briefing: result.briefing, fromCache: false, artifactsCreated: paths, transcripts: result.transcripts };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await upsertPlanTopic(opts, { ...topicForPlan, status: "failed", lastError: message }, now);
    throw err;
  }
}

export function getDeepResearchDir(ventureRoot: string): string {
  return `${ventureRoot}/00_research/${DEEP_RESEARCH_DIR_NAME}`;
}

export function getDeepResearchPlanPath(ventureRoot: string): string {
  return `${getDeepResearchDir(ventureRoot)}/${DEEP_RESEARCH_PLAN_FILE_NAME}`;
}

export function getDeepResearchBriefingJsonPath(ventureRoot: string, topicSlug: string): string {
  return `${getDeepResearchDir(ventureRoot)}/${DEEP_RESEARCH_BRIEFINGS_DIR_NAME}/${topicSlug}.json`;
}

export function getDeepResearchBriefingMarkdownPath(ventureRoot: string, topicSlug: string): string {
  return `${getDeepResearchDir(ventureRoot)}/${DEEP_RESEARCH_BRIEFINGS_DIR_NAME}/${topicSlug}.md`;
}

export function getDeepResearchSourcesIndexPath(ventureRoot: string): string {
  return `${getDeepResearchDir(ventureRoot)}/${DEEP_RESEARCH_SOURCES_DIR_NAME}/${DEEP_RESEARCH_SOURCES_INDEX_FILE_NAME}`;
}

export function getDeepResearchTranscriptPath(
  ventureRoot: string,
  channel: ResearchChannel | "planner" | "cross-reference" | "synthesiser",
  topicSlug: string,
  runId: string
): string {
  return `${getDeepResearchDir(ventureRoot)}/${DEEP_RESEARCH_TRANSCRIPTS_DIR_NAME}/${channel}/${topicSlug}-${runId}.json`;
}

export function getDeepResearchCheckpointPath(ventureRoot: string): string {
  return `${getDeepResearchDir(ventureRoot)}/${DEEP_RESEARCH_CHECKPOINT_FILE_NAME}`;
}

export function getDeepResearchPasteInDir(
  ventureRoot: string,
  channel: ResearchChannel,
  topicSlug: string
): string {
  return `${getDeepResearchDir(ventureRoot)}/paste-in/${channel}/${topicSlug}`;
}

export function getDeepResearchPasteInPromptPath(
  ventureRoot: string,
  channel: ResearchChannel,
  topicSlug: string
): string {
  return `${getDeepResearchPasteInDir(ventureRoot, channel, topicSlug)}/prompt.md`;
}

export function getDeepResearchPasteInResponsePath(
  ventureRoot: string,
  channel: ResearchChannel,
  topicSlug: string
): string {
  return `${getDeepResearchPasteInDir(ventureRoot, channel, topicSlug)}/response.md`;
}

export function getDeepResearchPasteInStatusPath(
  ventureRoot: string,
  channel: ResearchChannel,
  topicSlug: string
): string {
  return `${getDeepResearchPasteInDir(ventureRoot, channel, topicSlug)}/status.json`;
}

async function persistDeepResearchRun(
  opts: GatherDeepResearchOpts,
  result: OrchestrateTopicResult,
  runId: string
): Promise<string[]> {
  const paths: string[] = [];
  const briefingJsonPath = getDeepResearchBriefingJsonPath(opts.ventureRoot, opts.topic.slug);
  const briefingMarkdownPath = getDeepResearchBriefingMarkdownPath(opts.ventureRoot, opts.topic.slug);
  const sourcesIndexPath = getDeepResearchSourcesIndexPath(opts.ventureRoot);
  await opts.fs.writeFile(briefingJsonPath, `${JSON.stringify(result.briefing, null, 2)}\n`);
  await opts.fs.writeFile(briefingMarkdownPath, emitSourcedSectionsMarkdown(result.briefing));
  await opts.fs.writeFile(sourcesIndexPath, `${JSON.stringify(result.briefing.sources, null, 2)}\n`);
  paths.push(briefingJsonPath, briefingMarkdownPath, sourcesIndexPath);

  const transcriptEntries: Array<[ResearchChannel | "planner" | "cross-reference" | "synthesiser", unknown]> = [
    ["planner", result.transcripts.planner],
    ["cross-reference", result.transcripts.crossReference],
    ["synthesiser", result.transcripts.synthesiser],
  ];
  for (const [channel, partial] of result.transcripts.workers.successes) {
    transcriptEntries.push([channel, partial.rawTranscript]);
  }
  for (const [channel, payload] of transcriptEntries) {
    if (payload === null || payload === undefined) continue;
    const path = getDeepResearchTranscriptPath(opts.ventureRoot, channel, opts.topic.slug, runId);
    await opts.fs.writeFile(path, `${JSON.stringify(payload, null, 2)}\n`);
    paths.push(path);
  }
  return paths;
}

async function readFreshCachedBriefing(
  opts: GatherDeepResearchOpts,
  now: string,
  staleAfterDays: number
): Promise<ResearchBriefing | null> {
  const path = getDeepResearchBriefingJsonPath(opts.ventureRoot, opts.topic.slug);
  if (!(await opts.fs.exists(path))) return null;
  try {
    const parsed = ResearchBriefingSchema.parse(JSON.parse(await opts.fs.readFile(path)));
    const generatedAt = Date.parse(parsed.generatedAt);
    if (Number.isNaN(generatedAt)) return null;
    const ageMs = Date.parse(now) - generatedAt;
    if (ageMs > staleAfterDays * 24 * 60 * 60 * 1000) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function upsertPlanTopic(
  opts: Pick<GatherDeepResearchOpts, "fs" | "ventureRoot" | "manifest" | "topic" | "questions">,
  topic: ResearchPlanTopic,
  now: string
): Promise<void> {
  const path = getDeepResearchPlanPath(opts.ventureRoot);
  const plan = await readPlan(opts.fs, path, opts.manifest.slug, now);
  const existingIndex = plan.topics.findIndex((t) => t.slug === topic.slug);
  const nextTopic = { ...topic, questions: [...topic.questions] };
  if (existingIndex >= 0) plan.topics[existingIndex] = { ...plan.topics[existingIndex], ...nextTopic };
  else plan.topics.push(nextTopic);
  await opts.fs.writeFile(path, `${JSON.stringify(plan, null, 2)}\n`);
}

async function readPlan(
  fs: Filesystem,
  path: string,
  ventureSlug: string,
  now: string
): Promise<ResearchPlan> {
  if (await fs.exists(path)) {
    try {
      return ResearchPlanSchema.parse(JSON.parse(await fs.readFile(path)));
    } catch {
      // Fall through to a new plan; malformed cache should not block research.
    }
  }
  return {
    ventureSlug,
    topics: [],
    channels: [...DEFAULT_RESEARCH_CHANNELS],
    generatedAt: now,
  };
}

async function createDefaultWorkers(
  callLlm: CallLlm,
  requestPaste: RequestPasteIn | undefined
): Promise<ResearchProvider[]> {
  const providers = await import("@founder-os/research-deep-providers/node");
  return [
    providers.createClaudeSubProvider({ callLlm }),
    providers.createGeminiSubProvider(),
    providers.createChatgptSubProvider({
      requestPaste:
        requestPaste ??
        (async () => ({
          kind: "skipped",
          reason: "no requestPaste callback wired",
        })),
    }),
  ];
}

function createFilesystemPasteInRequest(fs: Filesystem, ventureRoot: string, now: string): RequestPasteIn {
  return async (req) => {
    const dir = getDeepResearchPasteInDir(ventureRoot, req.channel, req.topicSlug);
    const promptPath = getDeepResearchPasteInPromptPath(ventureRoot, req.channel, req.topicSlug);
    const responsePath = getDeepResearchPasteInResponsePath(ventureRoot, req.channel, req.topicSlug);
    const statusPath = getDeepResearchPasteInStatusPath(ventureRoot, req.channel, req.topicSlug);

    await fs.mkdir(dir);
    await fs.writeFile(promptPath, req.promptMarkdown);

    if (await fs.exists(responsePath)) {
      const markdown = await fs.readFile(responsePath);
      if (markdown.trim().length > 0) {
        await fs.writeFile(
          statusPath,
          `${JSON.stringify(
            {
              channel: req.channel,
              topicSlug: req.topicSlug,
              topicLabel: req.topicLabel,
              promptPath,
              responsePath,
              status: "pasted",
              updatedAt: now,
            } satisfies DeepResearchPasteInStatus,
            null,
            2
          )}\n`
        );
        return { kind: "pasted", markdown };
      }
    }

    await fs.writeFile(
      statusPath,
      `${JSON.stringify(
        {
          channel: req.channel,
          topicSlug: req.topicSlug,
          topicLabel: req.topicLabel,
          promptPath,
          responsePath,
          status: "pending",
          updatedAt: now,
        } satisfies DeepResearchPasteInStatus,
        null,
        2
      )}\n`
    );

    return {
      kind: "skipped",
      reason: `paste-in response pending at ${responsePath}`,
    };
  };
}

function assertCostCap(projectedCostGBP: number, maxCostGBP: number): void {
  if (projectedCostGBP > maxCostGBP) {
    throw new DeepResearchCostCapError(
      `Deep research projected GBP ${projectedCostGBP.toFixed(2)} exceeds cap GBP ${maxCostGBP.toFixed(2)}`
    );
  }
}

function buildArtifactIndexEntries(runId: string, paths: string[]): ArtifactIndexEntry[] {
  const nowIso = new Date().toISOString();
  return paths.map((path) => ({
    artifactId: `research-deep:${runId}:${path.split("/").pop() ?? path}`,
    stageName: "RESEARCH",
    type: path.endsWith(".md")
      ? "deep-research-briefing"
      : path.endsWith(".json")
        ? "deep-research-json"
        : "deep-research-artifact",
    path,
    createdAt: nowIso,
    status: "ready",
    runId,
  }));
}

function shortRunId(now: string): string {
  const parsed = Date.parse(now);
  return Number.isNaN(parsed) ? Date.now().toString(36) : parsed.toString(36);
}
