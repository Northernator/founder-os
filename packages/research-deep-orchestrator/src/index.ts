/**
 * @founder-os/research-deep-orchestrator — Node-only barrel.
 *
 * Slice 4 of the Deep Research arc (see RESEARCH-DEEP-MODULE-SPEC.md §7).
 * Coordinates the planner → parallel-workers → cross-referencer →
 * synthesiser flow that produces one ResearchBriefing per topic.
 *
 * Why Node-only: the orchestrator consumes ResearchProvider instances
 * from @founder-os/research-deep-providers/node (gemini-sub spawns a
 * CLI, research_py reads from disk). The WebView never imports this
 * package directly — it reaches the orchestrator via the Tauri host the
 * same way it reaches handoff-pack-providers/node.
 *
 * The orchestrator itself is pure DI: it never spawns processes, makes
 * HTTP calls, or touches the filesystem. The host wires every CallLlm
 * + every ResearchProvider with whichever transport, then calls
 * orchestrateTopic(). That keeps this package thin and testable —
 * the vitest suite drives it with vi.fn() fakes throughout.
 */

// Top-level orchestrator entry point.
export {
  orchestrateTopic,
  type OrchestrateTopicOpts,
  type OrchestrateTopicResult,
  type OrchestrateTopicTranscripts,
  type OrchestrateProgress,
} from "./orchestrate.js";

// Phase modules — exported so a stage runner can compose them differently
// (e.g. plan once + run workers across many topics in parallel).
export {
  planTopic,
  type PlannerInput,
  type PlannerResult,
  type PlanTopicOpts,
} from "./planner.js";

export {
  runParallelWorkers,
  type WorkerInput,
  type WorkerOutcome,
  type WorkerSuccess,
  type WorkerFailure,
  type RunParallelWorkersResult,
} from "./workers.js";

export {
  crossReference,
  type CrossReferenceInput,
  type CrossReferenceResult,
} from "./cross-reference.js";

export {
  synthesise,
  type SynthesiseInput,
  type SynthesiseResult,
} from "./synthesiser.js";

// Prompt blocks — exported so callers that want to tweak the prompts
// (e.g. for a different planning persona) can pass their own.
export {
  PLANNER_SYSTEM_PROMPT,
  CROSS_REFERENCE_SYSTEM_PROMPT,
  SYNTHESISER_SYSTEM_PROMPT,
  buildPlannerUserPrompt,
  buildCrossReferenceUserPrompt,
  buildSynthesiserUserPrompt,
} from "./prompts.js";

// Typed errors — callers (stage-runners, gatherDeepResearch helper)
// distinguish phase failures via these.
export {
  PlannerError,
  AllWorkersFailedError,
  CrossReferenceError,
  SynthesiserError,
} from "./errors.js";
