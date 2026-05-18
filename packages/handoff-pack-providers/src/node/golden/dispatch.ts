/**
 * Slice 6 -- Golden-16 dispatcher.
 *
 * NODE-ONLY.
 *
 * Wires the 16 individual createXxxStep functions into a single call
 * the slice-5 renderHandoffPackArtefactsStep can fold in. Returns a
 * contextOverrides record the slice-5 renderAllStubsStep already
 * consumes via opts.contextOverrides, plus diagnostics for the
 * checkpoint.
 *
 * Concurrency: all 16 steps are run in parallel via Promise.allSettled.
 * Each step is independent (different artefacts, different LLM prompts)
 * and the dispatcher must surface partial failures rather than aborting
 * the whole stage. The walker writes a `failed` inventory row when a
 * descriptor goes unfilled; that path stays intact here.
 */
import { createCompanyBriefStep } from "./strategy.js";
import { createMarketResearchStep } from "./strategy.js";
import { createIcpPersonasStep } from "./strategy.js";
import { createPrdStep } from "./product.js";
import { createMvpScopeStep } from "./product.js";
import { createUserStoriesStep } from "./product.js";
import { createBrandGuideStep } from "./design.js";
import { createDesignSystemStep } from "./design.js";
import { createWireframePackStep } from "./design.js";
import { createDeveloperBriefStep } from "./engineering.js";
import { createTechnicalSpecificationStep } from "./engineering.js";
import { createDatabaseSchemaStep } from "./engineering.js";
import { createApiSpecificationStep } from "./engineering.js";
import { createTestingStrategyStep } from "./ops.js";
import { createDeploymentGuideStep } from "./ops.js";
import { createFinancialModelStep } from "./ops.js";
import {
  GOLDEN_DOC_IDS,
  type GoldenStep,
  type GoldenStepContext,
  type GoldenStepResult,
} from "./types.js";

/**
 * Ordered registry of the 16 Tier-A steps. ORDER MATTERS for
 * deterministic test output -- the dispatcher iterates this list to
 * produce notes. The mapping is intentionally pinned to GOLDEN_DOC_IDS
 * so a manifest reshuffle surfaces as a TypeScript error rather than a
 * silent ordering drift.
 */
const GOLDEN_REGISTRY: ReadonlyArray<{ docId: (typeof GOLDEN_DOC_IDS)[number]; step: GoldenStep }> = [
  { docId: "company-brief", step: createCompanyBriefStep },
  { docId: "market-research", step: createMarketResearchStep },
  { docId: "icp-personas", step: createIcpPersonasStep },
  { docId: "prd", step: createPrdStep },
  { docId: "mvp-scope", step: createMvpScopeStep },
  { docId: "user-stories", step: createUserStoriesStep },
  { docId: "brand-guide", step: createBrandGuideStep },
  { docId: "design-system", step: createDesignSystemStep },
  { docId: "wireframe-pack", step: createWireframePackStep },
  { docId: "developer-brief", step: createDeveloperBriefStep },
  { docId: "technical-specification", step: createTechnicalSpecificationStep },
  { docId: "database-schema", step: createDatabaseSchemaStep },
  { docId: "api-specification", step: createApiSpecificationStep },
  { docId: "testing-strategy", step: createTestingStrategyStep },
  { docId: "deployment-guide", step: createDeploymentGuideStep },
  { docId: "financial-model", step: createFinancialModelStep },
];

export type DispatchGoldenStepsOpts = GoldenStepContext;

export type DispatchGoldenStepsResult = {
  /** Per-doc placeholder overrides. Keyed by descriptor.id. Slice-5's
   *  renderAllStubsStep already accepts this shape via contextOverrides. */
  contextOverrides: Record<string, Record<string, string>>;
  /** All per-step results, preserved for diagnostic dumps. */
  results: GoldenStepResult[];
  /** Counts the orchestrator surfaces in the checkpoint envelope. */
  counts: {
    /** Steps that completed (deterministic OR LLM). */
    completed: number;
    /** Subset of completed that actually used the LLM. */
    usedLlm: number;
    /** Subset that fell back to deterministic (caller-supplied LLM but it threw). */
    deterministicFallback: number;
    /** Steps that threw before producing a result. */
    failed: number;
  };
  /** Aggregated notes from every step + per-step failures. */
  notes: string[];
};

/**
 * Run all 16 Tier-A Golden steps. Idempotent + safe to call without an
 * LLM (each step degrades to deterministic placeholders).
 */
export async function dispatchGoldenSteps(
  opts: DispatchGoldenStepsOpts
): Promise<DispatchGoldenStepsResult> {
  const settled = await Promise.allSettled(
    GOLDEN_REGISTRY.map((entry) => entry.step(opts))
  );

  const contextOverrides: Record<string, Record<string, string>> = {};
  const results: GoldenStepResult[] = [];
  const notes: string[] = [];
  let completed = 0;
  let usedLlm = 0;
  let deterministicFallback = 0;
  let failed = 0;

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    const entry = GOLDEN_REGISTRY[i];
    if (outcome === undefined || entry === undefined) continue;
    const docId = entry.docId;
    if (outcome.status === "fulfilled") {
      const result = outcome.value;
      contextOverrides[result.docId] = result.placeholders;
      results.push(result);
      notes.push(...result.notes);
      completed++;
      if (result.usedLlm) {
        usedLlm++;
      } else if (opts.callLlm) {
        // Caller supplied an LLM but the step ended up deterministic --
        // surface this so the founder can see which docs fell back.
        deterministicFallback++;
      }
    } else {
      // Step threw before returning a result. Walk continues; the
      // descriptor will get a `failed` inventory row from the
      // slice-5 walker (because no contextOverrides means
      // unresolved placeholders for Tier-A -> strict-mode throw).
      failed++;
      const reason: unknown = outcome.reason;
      const m = reason instanceof Error ? reason.message : String(reason);
      notes.push(`golden:${docId} threw -- ${m}`);
    }
  }

  return {
    contextOverrides,
    results,
    counts: { completed, usedLlm, deterministicFallback, failed },
    notes,
  };
}

// Re-export the registry for tests + introspection. Frozen to avoid
// accidental mutation.
export const GOLDEN_STEP_REGISTRY = Object.freeze(GOLDEN_REGISTRY);
