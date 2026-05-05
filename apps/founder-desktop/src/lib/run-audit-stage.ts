/**
 * run-audit-stage.ts
 *
 * AuditStageRunner adoption helper. Persists a canonical
 * audit-summary-<runId>.json artifact alongside running the same
 * audit logic advance-gate.ts uses for preflight (deliberately two
 * paths: preflight is read-only, this runner is the formal stage).
 *
 * Forwards venture.stage as the explicit currentStage override so
 * the runner audits against the DB-authoritative stage rather than
 * the on-disk manifest which can lag.
 */
import type { Venture, VentureManifest, VentureStage } from "@founder-os/domain";
import type { LogEntry, StageRunResult } from "@founder-os/stage-runners";
import { AuditStageRunner, PipelineOrchestrator } from "@founder-os/stage-runners";
import { tauriFs } from "./pipeline-fs.js";

export type RunAuditStageOpts = {
  venture: Venture;
  manifest: VentureManifest;
  /**
   * DB-authoritative venture stage. Forwarded to auditVentureStep
   * via AuditStageRunnerOpts.ventureStage so audit rules with
   * minStage <= ventureStage fire. Falls back to manifest.currentStage
   * inside the runner when omitted.
   */
  ventureStage?: VentureStage;
  force?: boolean;
};

export type RunAuditStageResult = {
  result: StageRunResult;
  steps: { audit: "ok" | "missing" };
};

export async function runAuditStage(opts: RunAuditStageOpts): Promise<RunAuditStageResult> {
  const runner = new AuditStageRunner({
    manifest: opts.manifest,
    ventureRoot: opts.venture.rootPath,
    fs: tauriFs,
    ...(opts.ventureStage !== undefined ? { ventureStage: opts.ventureStage } : {}),
  });
  const orchestrator = new PipelineOrchestrator({
    manifest: opts.manifest,
    ventureRoot: opts.venture.rootPath,
    fs: tauriFs,
  });
  const result = await orchestrator.runStage(runner, { force: opts.force ?? true });
  return { result, steps: deriveSteps(result.logs) };
}

function deriveSteps(logs: LogEntry[]): { audit: "ok" | "missing" } {
  for (const e of logs) if (e.message === "audit step finished") return { audit: "ok" };
  return { audit: "missing" };
}
