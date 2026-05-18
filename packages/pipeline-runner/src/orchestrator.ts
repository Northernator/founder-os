import type { AuditFinding } from "@founder-os/audit-contract";
import type { VentureManifest, VentureStage } from "@founder-os/domain";
import { createLogger } from "@founder-os/logger";
import { type RunPlan, createRunPlan, planProgress, updateStep } from "@founder-os/pipeline-core";
import { type Filesystem, nodeFs } from "./fs.js";
import { auditVentureStep } from "./steps/audit-venture.js";
import { createBrandBriefStep } from "./steps/create-brand-brief.js";
import { createBuildHandoffStep } from "./steps/create-build-handoff.js";
import { createLogoPackStep } from "./steps/create-logo-pack.js";
import { createStitchPackStep } from "./steps/create-stitch-pack.js";
import { ensureBriefStep } from "./steps/ensure-brief.js";
import { ensureScreensStep } from "./steps/ensure-screens.js";
import { ensureSpecStep } from "./steps/ensure-spec.js";
import { ensureUkSetupStep } from "./steps/ensure-uk-setup.js";
import { generateLogoConceptsStep } from "./steps/generate-logo-concepts.js";
import { generateNamingCandidatesStep } from "./steps/generate-naming-candidates.js";

/**
 * Shared signature for LLM steps invoked from the orchestrator (pt.26).
 * Both `generate-naming-candidates` and `generate-logo-concepts` accept
 * this exact shape - the caller (desktop) wires it to its provider layer
 * (Rust-side dispatch via `invoke('llm_chat_collect', ...)` or similar).
 *
 * Seed-script / Node consumers omit `callLlm` and the LLM steps are
 * skipped automatically - the deterministic steps still run.
 */
export type OrchestratorLlmCaller = (prompt: {
  system: string;
  user: string;
}) => Promise<string>;

const log = createLogger("pipeline-runner:orchestrator");

export type OrchestratorOpts = {
  manifest: VentureManifest;
  ventureRoot: string;
  runId?: string;
  onProgress?: (plan: RunPlan) => void;
  /**
   * Filesystem adapter - defaults to nodeFs (for the seed script and any
   * other Node-process consumer). The desktop app passes a Tauri-backed
   * adapter that bridges to Rust commands, since the WebView has no fs.
   */
  fs?: Filesystem;
  /**
   * Authoritative current stage for the venture - used by the audit step
   * (pt.19) to filter rules whose minStage is ahead of where the venture
   * actually is. Optional; if omitted the audit falls back to
   * `manifest.currentStage`. The desktop passes `venture.stage` from the
   * DB explicitly because the on-disk manifest can lag behind DB updates
   * (handleStageChange only touches the DB, not venture.yaml).
   */
  ventureStage?: VentureStage;
  /**
   * Optional LLM caller - when provided, the orchestrator runs the brand
   * LLM steps (`generate-naming-candidates`, `generate-logo-concepts`)
   * in-line. When omitted those steps are marked `skipped` so seed
   * scripts and any Node-side consumers keep working without an LLM
   * provider plumbed in.
   *
   * Optional `seedHints` is forwarded to the naming step verbatim if
   * present - lets the desktop pass founder shortlists / "avoid" lists.
   */
  callLlm?: OrchestratorLlmCaller;
  namingSeedHints?: string;
  /**
   * pt.30c: optional abort signal checked between steps. When the
   * caller aborts mid-run (typically via the Stop button in the
   * desktop), the orchestrator skips remaining steps and returns
   * with `success: false, error: "cancelled"`. The same signal is
   * usually also threaded into `callLlm` so in-flight LLM calls
   * cancel immediately; this between-steps check covers the rest of
   * the pipeline (deterministic steps + the gap between LLM steps).
   *
   * Steps already in flight when the abort lands aren't interrupted
   * — deterministic steps complete in tens of ms so the wait is
   * negligible, and LLM-driven steps cancel via the signal threaded
   * into their `callLlm`. The orchestrator-level check is what stops
   * the FOR loop from advancing to the next step after a cancel.
   */
  signal?: AbortSignal;
};

export type OrchestratorResult = {
  plan: RunPlan;
  success: boolean;
  error?: string;
  /**
   * Findings produced by the audit step. Empty array means the step ran
   * and found nothing (a clean pass). The key is distinct from `undefined`,
   * which means the audit step didn't run (e.g. an earlier step failed).
   */
  findings: AuditFinding[];
};

const STEP_DEFS = [
  {
    id: "ensure-brief",
    name: "Ensure Dev Brief",
    description: "Scaffold a development brief if none exists",
  },
  {
    id: "generate-naming-candidates",
    name: "Generate Naming Candidates",
    description: "AI-generated venture name candidates (skipped without an LLM caller)",
  },
  {
    id: "create-brand-brief",
    name: "Create Brand Brief",
    description: "Generate brand identity - colours, fonts, personality",
  },
  {
    id: "create-logo-pack",
    name: "Create Logo Pack",
    description: "Materialize SVG logo assets from the brand brief",
  },
  {
    id: "generate-logo-concepts",
    name: "Generate Logo Concepts",
    description: "Write 4 logo concept briefs (skipped without an LLM caller)",
  },
  {
    id: "ensure-spec",
    name: "Ensure Product Spec",
    description:
      "Scaffold the spec canvas (purpose, personas, features, scope, data model, API, NFRs, metrics) and render the derived product-spec.md",
  },
  {
    id: "ensure-screens",
    name: "Ensure Screens Canvas",
    description:
      "Scaffold the screen inventory canvas (name + shell type + feature/entity mapping per screen) and render the derived screens.md",
  },
  {
    id: "create-stitch-pack",
    name: "Create Stitch Pack",
    description: "Generate design-to-code prompts for Stitch / v0 / Figma Make",
  },
  {
    id: "create-build-handoff",
    name: "Create Build Handoff",
    description: "Write the handoff bundle for the VS Code extension",
  },
  {
    id: "audit-venture",
    name: "Audit Venture",
    description: "Run sanity checks against artifacts and manifest",
  },
  {
    id: "ensure-uk-setup",
    name: "Ensure UK Setup Canvas",
    description: "Scaffold the UK admin canvas (entity, HMRC, banking, insurance, IP)",
  },
] as const;

export async function runPipeline(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  const { manifest, ventureRoot } = opts;
  const fs = opts.fs ?? nodeFs;
  const runId = opts.runId ?? crypto.randomUUID();

  log.info(`Starting pipeline run ${runId} for venture ${manifest.id}`);

  let plan = createRunPlan({
    runId,
    ventureId: manifest.id,
    targetStage: "BUILD_READY",
    steps: STEP_DEFS.map((s) => ({ ...s })),
  });

  opts.onProgress?.(plan);

  let lastBrandBrief: Awaited<ReturnType<typeof createBrandBriefStep>>["brief"] | null = null;
  // Collected by the audit step at the end of the pipeline. Starts empty so
  // callers can unconditionally read `.findings` on failure paths too.
  let findings: AuditFinding[] = [];

  for (const stepDef of STEP_DEFS) {
    const stepIdx = plan.steps.findIndex((s) => s.id === stepDef.id);
    if (stepIdx === -1) continue;

    // pt.30c: bail before starting the next step if the caller has
    // aborted. The earlier `await opts.callLlm(...)` inside an LLM
    // step will have already rejected and either propagated up or
    // been swallowed by the step into a "failed" result; this check
    // makes sure we don't grind through subsequent deterministic
    // steps after the user said stop. Returning early surfaces
    // success: false + error: "cancelled" to the caller, which
    // discriminates against "failed" via the dedicated DB status
    // (pt.30b) and the signal-aborted check on the desktop side.
    if (opts.signal?.aborted) {
      log.info(`Pipeline run ${runId} cancelled before step ${stepDef.id}`);
      return { plan, success: false, error: "cancelled", findings };
    }

    plan = updateStep(plan, stepDef.id, {
      status: "running",
      startedAt: new Date().toISOString(),
    });
    opts.onProgress?.(plan);

    try {
      // Steps return Partial<RunStep>, so status/producedArtifactIds are
      // optional. Fall back to sensible defaults at the updateStep call.
      let result: { status?: string; producedArtifactIds?: string[] };

      switch (stepDef.id) {
        case "ensure-brief":
          result = await ensureBriefStep({
            fs,
            ventureId: manifest.id,
            ventureRoot,
            ventureName: manifest.name,
            appType: manifest.appType,
            industry: manifest.industry,
          });
          break;

        case "ensure-spec":
          // pt.41: rewritten to scaffold the spec canvas JSON and
          // re-render the derived product-spec.md from the canvas on
          // every pipeline run. Now takes the full manifest (used for
          // ventureName + future appType-specific gating in
          // deriveProductSpecRules). Slot in the step order matches
          // VENTURE_STAGE_ORDER: BRAND_READY → SPEC_READY → ...
          result = await ensureSpecStep({
            fs,
            manifest,
            ventureRoot,
          });
          break;

        case "ensure-screens":
          // pt.43: scaffolds the screen inventory canvas at
          // 06_product/wireframes/screens-canvas.json and re-renders
          // screens.md from it on every run. Sits between ensure-spec
          // and create-stitch-pack so the stitch step (pt.44) can
          // read the canvas and emit per-screen direction. The stage
          // value is still WIREFRAME_READY (legacy enum); see
          // packages/domain/src/screens.ts for the deliberately-
          // narrowed scope vs full element-level wireframes.
          result = await ensureScreensStep({
            fs,
            manifest,
            ventureRoot,
          });
          break;

        case "generate-naming-candidates": {
          // Skip cleanly when no LLM caller is wired in (seed script,
          // Node-side consumers). Deterministic steps still run; this
          // matches the seed/CI expectation of running pipeline without
          // burning tokens.
          if (!opts.callLlm) {
            result = { status: "skipped", producedArtifactIds: [] };
            break;
          }
          const r = await generateNamingCandidatesStep({
            fs,
            manifest,
            ventureRoot,
            callLlm: opts.callLlm,
            seedHints: opts.namingSeedHints,
          });
          // The step returns "done" | "partial" | "failed". Match the
          // throw-on-failure pattern used by every other step - soft-
          // failing mid-pipeline gets recorded as `success: true` by
          // the loop and confuses the UI. Collapse "partial" into "done"
          // so dup-only reruns aren't treated as a failure.
          if (r.status === "failed") {
            throw new Error(r.note ?? "Naming candidate generation failed");
          }
          result = { status: "done", producedArtifactIds: [] };
          break;
        }

        case "create-brand-brief": {
          if (!opts.callLlm) {
            // Brief is LLM-narrated now -- skip if the consumer hasn't
            // plumbed in a caller. The brand stage runner enforces a
            // hard requirement at validate() time; this orchestrator
            // path stays soft for Node-side / seed consumers.
            result = { status: "skipped", producedArtifactIds: [] };
            break;
          }
          const r = await createBrandBriefStep({
            fs,
            manifest,
            ventureRoot,
            callLlm: opts.callLlm,
          });
          lastBrandBrief = r.brief;
          result = r;
          break;
        }

        case "create-logo-pack":
          if (!lastBrandBrief) throw new Error("Brand brief must be created before logo pack");
          if (!opts.callLlm) {
            // Logo step is LLM-driven now (subscription-CLI preferred,
            // outputs SVG). Soft-skip for Node / seed consumers that
            // didn't plumb a caller in; the desktop brand runner
            // enforces a hard requirement at validate() time.
            result = { status: "skipped", producedArtifactIds: [] };
            break;
          }
          result = await createLogoPackStep({
            fs,
            ventureId: manifest.id,
            ventureRoot,
            brief: lastBrandBrief,
            callLlm: opts.callLlm,
          });
          break;

        case "generate-logo-concepts": {
          if (!opts.callLlm) {
            result = { status: "skipped", producedArtifactIds: [] };
            break;
          }
          if (!lastBrandBrief) {
            // Brand brief is required input; if it's missing the prior
            // step would have thrown. Defensive guard so a future
            // reorder doesn't produce a confusing TypeError.
            throw new Error("Brand brief must be created before logo concepts");
          }
          const r = await generateLogoConceptsStep({
            fs,
            ventureRoot,
            brief: lastBrandBrief,
            callLlm: opts.callLlm,
          });
          // Same throw-on-failure pattern as naming. "partial" means at
          // least one concept landed - keep going; the per-concept
          // outcomes are visible to the desktop via the artifacts tab
          // file scanner.
          if (r.status === "failed") {
            const failed = r.outcomes
              .filter((o) => o.status === "failed")
              .map((o) => o.spec.filename)
              .join(", ");
            throw new Error(
              `Logo concept generation failed for all 4 concepts (${failed || "no concepts written"})`
            );
          }
          result = { status: "done", producedArtifactIds: [] };
          break;
        }

        case "ensure-uk-setup":
          // pt.33: deterministic, no LLM, no signal needed (file write
          // completes in ms). Runs late because UK_SETUP_READY now sits
          // after CRM_READY in VENTURE_STAGE_ORDER.
          result = await ensureUkSetupStep({
            fs,
            manifest,
            ventureRoot,
          });
          break;

        case "create-stitch-pack":
          if (!lastBrandBrief) throw new Error("Brand brief must be created before stitch pack");
          result = await createStitchPackStep({
            fs,
            ventureId: manifest.id,
            ventureRoot,
            brief: lastBrandBrief,
            appType: manifest.appType,
          });
          break;

        case "create-build-handoff":
          if (!lastBrandBrief) throw new Error("Brand brief must be created before build handoff");
          result = await createBuildHandoffStep({
            fs,
            manifest,
            ventureRoot,
            brief: lastBrandBrief,
          });
          break;

        case "audit-venture": {
          const r = await auditVentureStep({
            fs,
            manifest,
            ventureRoot,
            ventureStage: opts.ventureStage,
          });
          findings = r.findings;
          result = r;
          break;
        }

        default:
          result = { status: "skipped", producedArtifactIds: [] };
      }

      plan = updateStep(plan, stepDef.id, {
        status: (result.status ?? "done") as "done" | "skipped",
        completedAt: new Date().toISOString(),
        producedArtifactIds: result.producedArtifactIds ?? [],
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error(`Step ${stepDef.id} failed: ${error}`);
      plan = updateStep(plan, stepDef.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error,
      });
      opts.onProgress?.(plan);
      return { plan, success: false, error, findings };
    }

    opts.onProgress?.(plan);
  }

  const progress = planProgress(plan);
  log.info(
    `Pipeline run ${runId} complete - ${progress.done}/${progress.total} steps done, ${findings.length} finding(s)`
  );
  return { plan, success: true, findings };
}
