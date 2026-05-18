/**
 * Top-level orchestration flow for one topic.
 *
 * Plan → workers (parallel) → cross-reference → synthesise → ResearchBriefing
 *
 * Spec §7. Claude is the canonical planner / cross-referencer /
 * synthesiser; workers are 2-3 of {claude-sub, chatgpt-sub, gemini-sub}.
 * The orchestrator never spawns processes or makes HTTP calls itself —
 * it consumes injected CallLlms (for the Claude-driven phases) and pre-
 * built ResearchProvider instances (for the parallel workers).
 *
 * Failure modes:
 *   - planner: PlannerError after fallback chain exhausted
 *   - workers (0 successes): AllWorkersFailedError
 *   - cross-reference / synthesiser: CrossReferenceError / SynthesiserError
 *
 * Single-channel deterministic fallback: when exactly one worker
 * succeeds, the orchestrator skips cross-reference entirely and produces
 * the briefing via passthrough synthesis. This keeps a degraded run
 * useful rather than failing the whole topic.
 *
 * Transcripts: every phase's raw LLM exchange is collected into an
 * OrchestrateTopicTranscripts record so the caller (gatherDeepResearch
 * helper) can persist them under 00_research/deep/transcripts/ verbatim.
 */

import type {
  CallLlm,
  ResearchBriefing,
  ResearchChannel,
  ResearchProvider,
  ResearchQuestion,
} from "@founder-os/research-deep-core";
import { AllWorkersFailedError } from "./errors.js";
import { crossReference, type CrossReferenceResult } from "./cross-reference.js";
import { planTopic, type PlannerResult } from "./planner.js";
import { runParallelWorkers, type RunParallelWorkersResult } from "./workers.js";
import { synthesise, type SynthesiseResult } from "./synthesiser.js";

export type OrchestrateProgress =
  | { phase: "planner-start"; topicSlug: string }
  | { phase: "planner-done"; topicSlug: string; questionCount: number; fallbackIndex: number }
  | { phase: "workers-start"; topicSlug: string; providers: ResearchChannel[] }
  | { phase: "workers-done"; topicSlug: string; successes: ResearchChannel[]; failures: ResearchChannel[] }
  | { phase: "cross-reference-skipped"; topicSlug: string; reason: "single-channel" }
  | { phase: "cross-reference-start"; topicSlug: string }
  | { phase: "cross-reference-done"; topicSlug: string; disagreementCount: number }
  | { phase: "cross-reference-degraded"; topicSlug: string; error: unknown }
  | { phase: "synthesiser-start"; topicSlug: string; mode: "deterministic" | "llm" }
  | { phase: "synthesiser-done"; topicSlug: string; sectionCount: number };

export interface OrchestrateTopicOpts {
  ventureSlug: string;
  topic: { slug: string; label: string };
  ventureContext: string;
  /**
   * Optional seed questions from the stage runner. The planner refines /
   * supplements these rather than discarding them.
   */
  seedQuestions?: ReadonlyArray<ResearchQuestion>;
  /**
   * Ordered planner CallLlm chain. Index 0 is the primary (claude-sub on
   * the host side); subsequent indices are fallbacks (claude-api, then
   * gemini-sub per spec §7).
   */
  plannerCallLlmChain: ReadonlyArray<CallLlm>;
  /**
   * Pre-built worker providers — typically 2-3 of {claude-sub,
   * chatgpt-sub, gemini-sub}. The orchestrator runs every provider in
   * parallel.
   */
  workers: ReadonlyArray<ResearchProvider>;
  /**
   * CallLlm for the cross-reference phase. Skipped automatically when
   * only one worker partial is available.
   */
  crossReferenceCallLlm: CallLlm;
  /** CallLlm for the synthesiser. Skipped automatically in single-channel runs. */
  synthesiserCallLlm: CallLlm;
  /** Channel tag stamped into ResearchBriefing.synthesisedBy. Default "claude-sub". */
  synthesiserChannel?: ResearchChannel;
  /** ISO accessedAt stamped onto Source records returned by workers. */
  accessedAt?: string;
  /** Stamped into ResearchBriefing.generatedAt. Default: Date.now(). */
  generatedAt?: string;
  /** Carried through to ResearchBriefing.staleAfterDays. */
  staleAfterDays?: number;
  /**
   * Cooperative cancellation. Forwarded to each provider; the orchestrator
   * itself only re-throws AbortError if the signal aborts before the
   * planner returns (afterwards we let in-flight workers finish — they
   * cooperate via their own provider-level signal handling).
   */
  signal?: AbortSignal;
  /** Optional progress sink — fires once per phase boundary. */
  onProgress?: (event: OrchestrateProgress) => void;
}

export interface OrchestrateTopicTranscripts {
  planner: { rawResponse: string; fallbackIndex: number };
  workers: RunParallelWorkersResult;
  crossReference?: CrossReferenceResult;
  synthesiser: SynthesiseResult;
}

export interface OrchestrateTopicResult {
  briefing: ResearchBriefing;
  questions: ResearchQuestion[];
  transcripts: OrchestrateTopicTranscripts;
}

/**
 * Run the full planner → workers → cross-ref → synthesis flow for one
 * topic. Returns the validated ResearchBriefing + the per-phase
 * transcripts so the caller can persist them under
 * 00_research/deep/transcripts/.
 */
export async function orchestrateTopic(
  opts: OrchestrateTopicOpts,
): Promise<OrchestrateTopicResult> {
  const accessedAt = opts.accessedAt ?? new Date().toISOString();
  const generatedAt = opts.generatedAt ?? accessedAt;
  const synthesiserChannel = opts.synthesiserChannel ?? "claude-sub";
  const progress = opts.onProgress ?? (() => undefined);

  // ---- Phase 1: plan ----------------------------------------------------
  progress({ phase: "planner-start", topicSlug: opts.topic.slug });
  const planResult: PlannerResult = await planTopic(
    {
      topic: opts.topic,
      ventureContext: opts.ventureContext,
      seedQuestions: opts.seedQuestions,
    },
    { callLlmChain: opts.plannerCallLlmChain },
  );
  progress({
    phase: "planner-done",
    topicSlug: opts.topic.slug,
    questionCount: planResult.questions.length,
    fallbackIndex: planResult.fallbackIndex,
  });

  // ---- Phase 2: parallel workers ---------------------------------------
  progress({
    phase: "workers-start",
    topicSlug: opts.topic.slug,
    providers: opts.workers.map((w) => w.name),
  });
  const workerResult = await runParallelWorkers(opts.workers, {
    topic: opts.topic,
    questions: planResult.questions,
    ventureContext: opts.ventureContext,
    accessedAt,
    signal: opts.signal,
  });
  progress({
    phase: "workers-done",
    topicSlug: opts.topic.slug,
    successes: [...workerResult.successes.keys()],
    failures: [...workerResult.failures.keys()],
  });

  if (workerResult.successes.size === 0) {
    const failureCauses = new Map<string, unknown>();
    for (const [channel, failure] of workerResult.failures) {
      failureCauses.set(channel, failure.error ?? failure.reason);
    }
    throw new AllWorkersFailedError(failureCauses);
  }

  const partials = [...workerResult.successes.entries()].map(
    ([channel, partial]) => ({ channel, partial }),
  );

  // ---- Phase 3: cross-reference (multi-channel only) -------------------
  let crossRef: CrossReferenceResult | undefined;
  if (partials.length >= 2) {
    progress({ phase: "cross-reference-start", topicSlug: opts.topic.slug });
    try {
      crossRef = await crossReference(
        { topic: opts.topic, partials },
        { callLlm: opts.crossReferenceCallLlm },
      );
      progress({
        phase: "cross-reference-done",
        topicSlug: opts.topic.slug,
        disagreementCount: crossRef.disagreements.length,
      });
    } catch (err) {
      // Cross-reference failure is non-fatal — degrade to synthesiser
      // without annotation rather than fail the topic. The briefing
      // surfaces this by leaving llmVerdicts empty.
      progress({
        phase: "cross-reference-degraded",
        topicSlug: opts.topic.slug,
        error: err,
      });
    }
  } else {
    progress({
      phase: "cross-reference-skipped",
      topicSlug: opts.topic.slug,
      reason: "single-channel",
    });
  }

  // ---- Phase 4: synthesise ---------------------------------------------
  const synthMode = partials.length === 1 ? "deterministic" : "llm";
  progress({ phase: "synthesiser-start", topicSlug: opts.topic.slug, mode: synthMode });
  const synthResult = await synthesise(
    {
      ventureSlug: opts.ventureSlug,
      topic: opts.topic,
      ventureContext: opts.ventureContext,
      questions: planResult.questions,
      partials,
      ...(crossRef
        ? {
            verdictsByHeading: crossRef.verdictsByHeading,
            disagreements: crossRef.disagreements,
            crossReferenceJson: crossRef.rawJson,
          }
        : {}),
      generatedAt,
      synthesiserChannel,
      ...(opts.staleAfterDays != null
        ? { staleAfterDays: opts.staleAfterDays }
        : {}),
    },
    { callLlm: opts.synthesiserCallLlm },
  );
  progress({
    phase: "synthesiser-done",
    topicSlug: opts.topic.slug,
    sectionCount: synthResult.briefing.sections.length,
  });

  return {
    briefing: synthResult.briefing,
    questions: planResult.questions,
    transcripts: {
      planner: {
        rawResponse: planResult.rawResponse,
        fallbackIndex: planResult.fallbackIndex,
      },
      workers: workerResult,
      ...(crossRef ? { crossReference: crossRef } : {}),
      synthesiser: synthResult,
    },
  };
}
