import type { ReviewGate, StageName, VentureManifest, VentureStage } from "@founder-os/domain";
import { VENTURE_STAGE_ORDER } from "@founder-os/domain";
import { auditVentureStep } from "@founder-os/pipeline-runner";
import * as db from "./db.js";
import { tauriFs } from "./pipeline-fs.js";
import { findPendingReviewGateForStage } from "./review-gates.js";
import { loadVentureManifest } from "./venture-io.js";

/**
 * Pre-flight audit gate for the per-tab "Advance to next stage" button.
 *
 * Runs the audit step against the venture as if it were already at
 * `nextStage` -- every rule whose `minStage` lands at or before `nextStage`
 * fires, which is exactly the set of checks that gate entry into that
 * stage. Findings are persisted via the same `audit_findings` table the
 * AuditTab reads, so a Research-side preflight that surfaces blockers also
 * shows up in the Audit tab without needing a full pipeline run.
 *
 * Severity split mirrors the convention used elsewhere in the desktop:
 *   - blockers: critical + high  (advance disabled, must fix)
 *   - warnings: medium + low     (advance allowed with explicit confirm)
 *
 * Slice 4 of stage-runners adds a third dimension: `pendingReviewGate`.
 * When advancing into a stage that has a pending human-review gate
 * (BRAND, AUDIT by default) the gate is surfaced alongside audit
 * findings so the AdvanceConfirmModal can render it as the canonical
 * blocker. The gate is the actual reason advance is blocked; audit
 * blockers are supplementary.
 */

export type AdvancePreflight = {
  blockers: db.FindingRow[];
  warnings: db.FindingRow[];
  runId: string;
  /**
   * Pending review gate for the StageName whose STAGE_PRODUCES marker
   * matches `nextStage`, or null if no gate is pending. The modal
   * surfaces this and offers an "Approve and advance" CTA that calls
   * approveReviewGate before triggering onAdvance.
   */
  pendingReviewGate: ReviewGate | null;
};

function newRunId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `preflight-${crypto.randomUUID()}`;
  }
  return `preflight-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Stage immediately after the given one in `VENTURE_STAGE_ORDER`. Returns
 * null at the end of the chain (LIVE has no next). Used by the dashboard
 * progress hint where we don't always know the explicit transition target.
 */
export function nextStageAfter(stage: VentureStage): VentureStage | null {
  const idx = VENTURE_STAGE_ORDER.indexOf(stage);
  if (idx < 0 || idx >= VENTURE_STAGE_ORDER.length - 1) return null;
  return VENTURE_STAGE_ORDER[idx + 1];
}

/**
 * Inverse lookup: which StageName produces this VentureStage marker?
 * Used by the preflight to find a pending review gate keyed by
 * StageName when callers know only the post-completion VentureStage.
 *
 * Hardcoded inverse rather than iterating STAGE_PRODUCES so the
 * FINANCE -> BRAND_READY collision in STAGE_PRODUCES (FINANCE is
 * parallel to BRAND and reuses the same marker) resolves
 * deterministically to BRAND. Returns null for markers that aren't
 * produced by a runner -- notably "IDEA" (entry state) and "LIVE"
 * (terminal state). Callers treat null as "no review gate possible
 * for this transition".
 */
const STAGE_PRODUCES_INVERSE: Partial<Record<VentureStage, StageName>> = {
  RESEARCHED: "RESEARCH",
  VALIDATED: "VALIDATION",
  BRAND_READY: "BRAND",
  UK_SETUP_READY: "UK_SETUP",
  SPEC_READY: "PRODUCT_SPEC",
  WIREFRAME_READY: "WIREFRAME",
  STITCH_READY: "HANDOFF",
  BUILD_READY: "BUILD",
  AUDIT_READY: "AUDIT",
  LAUNCH_READY: "LAUNCH",
};

export function stageNameForVentureStage(stage: VentureStage): StageName | null {
  return STAGE_PRODUCES_INVERSE[stage] ?? null;
}

export type RunAdvancePreflightInput = {
  ventureId: string;
  ventureRoot: string;
  /**
   * Stage we're trying to *land in*. Audit runs with this as the
   * `ventureStage` context so all rules with minStage <= nextStage fire.
   * Pass the same value the existing `onAdvanceStage(stage)` call uses.
   */
  nextStage: VentureStage;
  /**
   * Manifest the tab already has from props. Optional -- if omitted we fall
   * back to reading venture.yaml from disk via loadVentureManifest. Passing
   * the in-memory copy avoids the round-trip on every click.
   */
  manifest?: VentureManifest | null;
};

export async function runAdvancePreflight(
  input: RunAdvancePreflightInput
): Promise<AdvancePreflight> {
  // Look up any pending review gate first. Independent of audit so a
  // missing manifest still surfaces gate state.
  const stageName = stageNameForVentureStage(input.nextStage);
  const pendingReviewGate = stageName
    ? await findPendingReviewGateForStage(input.ventureRoot, stageName)
    : null;

  let manifest = input.manifest ?? null;
  if (!manifest) {
    manifest = await loadVentureManifest(input.ventureRoot);
  }
  if (!manifest) {
    // No manifest on disk and none passed in -- we can't run the audit
    // cleanly. Fail open with empty findings so the caller can still let
    // the user advance. The missing manifest is a separate problem the
    // IdeaTab surfaces.
    return { blockers: [], warnings: [], runId: newRunId(), pendingReviewGate };
  }

  const result = await auditVentureStep({
    fs: tauriFs,
    manifest,
    ventureRoot: input.ventureRoot,
    ventureStage: input.nextStage,
  });

  // Strip the synthetic "deferred-rules" footer finding -- useful in the
  // AuditTab footer, noise here. It's emitted verbatim with a low severity
  // so it would otherwise count as a warning the user can't action.
  const realFindings = result.findings.filter((f) => f.ruleId !== "audit.meta.deferred-rules");

  const runId = newRunId();
  await db.insertAuditFindings({
    runId,
    ventureId: input.ventureId,
    findings: realFindings.map((f) => ({
      ruleId: f.ruleId,
      severity: f.severity,
      title: f.title,
      message: f.message,
      filePath: f.evidence?.[0]?.filePath,
    })),
  });

  // Re-read the persisted rows so callers get a stable shape (FindingRow
  // with id / runId / createdAt) -- the AdvanceConfirmModal keys list rows
  // off `id`, and the optional "Open file" affordance routes through
  // db.openInEditor which expects a FindingRow.
  const persisted = await db.listFindingsForRun(runId);

  const blockers: db.FindingRow[] = [];
  const warnings: db.FindingRow[] = [];
  for (const f of persisted) {
    if (f.severity === "critical" || f.severity === "high") {
      blockers.push(f);
    } else {
      warnings.push(f);
    }
  }
  return { blockers, warnings, runId, pendingReviewGate };
}
