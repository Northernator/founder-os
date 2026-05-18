/**
 * gemini-sub provider — tier_0, Gemini Advanced via gemini-cli.
 *
 * Strength: fastest, cheapest source coverage. Google Search is broad and
 * current. Slightly weaker at synthesis than Claude — used as a worker,
 * not as the canonical synthesiser.
 *
 * Surface: gemini-cli with Google Search grounding enabled. Same spawn
 * pattern as the hyperframes / claude-cli callers — see spawn.ts for the
 * PATH × PATHEXT, --skip-trust, stdin-prompt, BatBadBut-safe details.
 *
 * Output: gemini-cli prints the model's reply to stdout. When grounding
 * fires, the reply ends with a "Sources:" block that the founder's models
 * already produce. Our shared parser (`parsePastedDeepResearch`) handles
 * both the explicit "**Sources consulted:**" block and the heuristic
 * trailing-bullets-with-URLs block, so we don't need special handling for
 * Gemini's format.
 *
 * NODE-ONLY — spawns a subprocess. Not safe to import in the WebView.
 * Reach this provider from Node via `@founder-os/research-deep-providers/node`.
 */

import {
  parsePastedDeepResearch,
  type ProviderPartial,
  type ResearchProvider,
  type ResearchTopicOpts,
} from "@founder-os/research-deep-core";
import {
  RESEARCH_WORKER_SYSTEM_PROMPT,
  buildWorkerUserPrompt,
} from "./prompts.js";
import {
  GeminiExitError,
  GeminiNotFoundError,
  isGeminiCliAvailable,
  runGemini,
  type GeminiSpawnOpts,
} from "./spawn.js";

export interface CreateGeminiSubProviderOpts {
  /** Binary name or absolute path. Default "gemini". */
  binary?: string;
  /** Working dir for the spawn. Default process.cwd(). */
  cwd?: string;
  /** Per-call timeout. Default 120s. */
  timeoutMs?: number;
  /**
   * Override the model. Default lets gemini-cli pick its default
   * (currently 2.5-pro on Advanced subscriptions). Example: "gemini-2.5-pro".
   */
  model?: string;
  /**
   * Extra args appended after `--skip-trust`. Useful for `--temperature 0`
   * or for switching to `--json` output once the CLI supports a stable
   * JSON shape for grounded responses.
   */
  extraArgs?: ReadonlyArray<string>;
  /**
   * Override the system prompt. The default is the shared
   * RESEARCH_WORKER_SYSTEM_PROMPT — change only when testing.
   */
  systemOverride?: string;
}

export class GeminiSubInvocationError extends Error {
  constructor(cause: string) {
    super(`gemini-sub: ${cause}`);
    this.name = "GeminiSubInvocationError";
  }
}

/**
 * Build a gemini-cli-backed `ResearchProvider`. `available()` probes via
 * `gemini --version`; `researchTopic` spawns one `gemini` call with the
 * system + user prompts piped via stdin.
 */
export function createGeminiSubProvider(
  opts: CreateGeminiSubProviderOpts = {},
): ResearchProvider {
  const binary = opts.binary ?? "gemini";
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const systemPrompt = opts.systemOverride ?? RESEARCH_WORKER_SYSTEM_PROMPT;

  // gemini-cli args common to every call. --skip-trust avoids the
  // first-run interactive trust prompt. The user prompt goes via stdin
  // (see spawn.ts for the BatBadBut rationale).
  const baseArgs = ["--skip-trust"];
  if (opts.model) baseArgs.push("--model", opts.model);
  if (opts.extraArgs) baseArgs.push(...opts.extraArgs);

  const spawnOpts: GeminiSpawnOpts = {
    binary,
    cwd: opts.cwd,
    timeoutMs,
  };

  return {
    name: "gemini-sub",

    async available(): Promise<boolean> {
      try {
        return await isGeminiCliAvailable(binary);
      } catch {
        return false;
      }
    },

    async researchTopic(topicOpts: ResearchTopicOpts): Promise<ProviderPartial> {
      const accessedAt = topicOpts.accessedAt ?? new Date().toISOString();
      const userPrompt = buildWorkerUserPrompt({
        topic: topicOpts.topic,
        questions: topicOpts.questions,
        ventureContext: topicOpts.ventureContext,
        accessedAt,
      });

      // gemini-cli (as of late 2025) takes the system prompt as a flag and
      // the user prompt via stdin when no -p/--prompt is given. Pass both
      // via stdin in a separator-delimited form so we don't trip CLI
      // surface drift: "<SYSTEM>\n\n---\n\n<USER>" is robust enough that
      // even if gemini-cli changes its --system flag the model still gets
      // the right shape.
      const fullStdin =
        `[System instruction]\n${systemPrompt}\n\n` +
        `---\n\n[User request]\n${userPrompt}\n`;

      let result;
      try {
        result = await runGemini(baseArgs, { ...spawnOpts, stdin: fullStdin });
      } catch (err) {
        if (err instanceof GeminiNotFoundError) {
          throw err; // surface intact — the bridge maps this to the install hint UI
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new GeminiSubInvocationError(msg);
      }

      if (result.code !== 0) {
        throw new GeminiExitError(baseArgs, result);
      }
      if (!result.stdout.trim()) {
        throw new GeminiSubInvocationError("empty stdout from gemini-cli");
      }

      const partial = parsePastedDeepResearch(result.stdout, {
        channel: "gemini-sub",
        accessedAt,
        expectedQuestions: topicOpts.questions.map((q) => q.question),
      });

      return {
        ...partial,
        rawTranscript: {
          channel: "gemini-sub",
          stdinPayload: fullStdin,
          stdout: result.stdout,
          stderrTail: result.stderr.slice(-2000),
        },
      };
    },
  };
}
