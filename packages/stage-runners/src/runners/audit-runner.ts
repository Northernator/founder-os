/**
 * AuditStageRunner -- wraps auditVentureStep with the StageRunner contract.
 *
 * The audit stage runs a battery of pure deterministic checks against
 * the venture state on disk. No LLM, no network. The underlying step
 * returns AuditFinding[] in memory; this runner persists a summary
 * artifact to 07_build/audits/audit-summary-<runId>.json so the
 * desktop can render historical audits without re-running.
 *
 * Coexistence with advance-gate.ts:
 * ---------------------------------
 * advance-gate.ts ALSO calls auditVentureStep directly (preflight
 * gate for the per-tab "Advance to next stage" button). That is
 * deliberately separate -- the preflight is a synchronous read-only
 * check tied to a UI action; this runner is the canonical "I'm
 * formally running the AUDIT stage" path that produces an artifact +
 * stage progress + review gate. Both can coexist; preflight reads the
 * same audit logic but doesn't write the canonical summary file.
 *
 * Failure semantics:
 * ------------------
 *  - Step throws (IO error, etc): success=false, recoverable=true.
 *    Retry might help if the underlying issue was transient.
 *  - Step returns findings with critical/high severity: success=false,
 *    recoverable=false (re-running won't help -- fix the blockers).
 *    The summary artifact IS still written so the user can inspect
 *    findings.
 *  - Step returns clean (no critical/high): success=true. AUDIT is in
 *    DEFAULT_REVIEW_GATES so a security-review gate is created
 *    automatically.
 */
import type {
  ArtifactIndexEntry,
  ReviewGate,
  StageName,
  StageRunResult,
  ValidationResult,
  VentureManifest,
} from "@founder-os/domain";
import type { AuditVentureResult, Filesystem } from "@founder-os/pipeline-runner";
import { auditVentureStep } from "@founder-os/pipeline-runner";
import { getAuditsDir } from "@founder-os/workspace-core";
import { BaseStageRunner } from "../runner-base.js";
import type { StageRunner } from "../types.js";

type AuditFinding = AuditVentureResult["findings"][number];

export type AuditStageRunnerOpts = {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
  /**
   * Optional explicit current-stage override forwarded to
   * auditVentureStep. The desktop passes venture.stage from its DB
   * (authoritative) because the on-disk manifest can lag behind DB
   * updates. Node consumers leave it undefined and the step falls back
   * to manifest.currentStage.
   */
  ventureStage?: VentureManifest["currentStage"];
  runId?: string;
};

/**
 * True iff no critical/high findings are present. Inlined rather than
 * importing audit-contract's auditPassed() helper -- keeps the
 * stage-runners package's dep set minimal.
 */
function passedAudit(findings: AuditFinding[]): boolean {
  return !findings.some((f) => f.severity === "critical" || f.severity === "high");
}

function countBySeverity(findings: AuditFinding[]): {
  critical: number;
  high: number;
  medium: number;
  low: number;
} {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

export class AuditStageRunner extends BaseStageRunner implements StageRunner {
  readonly stageName: StageName = "AUDIT";
  private readonly ventureStage: VentureManifest["currentStage"] | undefined;

  constructor(opts: AuditStageRunnerOpts) {
    super(opts.ventureRoot, opts.fs, opts.manifest, opts.runId);
    this.ventureStage = opts.ventureStage;
  }

  async validate(): Promise<ValidationResult> {
    const errors: string[] = [];

    if (!this.manifest.id?.trim()) {
      errors.push("manifest.id is required for audit stage");
    }
    // currentStage on the manifest is required by VentureManifestSchema
    // (the enum has no implicit default). validate() doesn't need to
    // check it -- if the manifest parsed it's set. But callers can
    // still pass an explicit ventureStage if the DB diverges from disk.

    return {
      valid: errors.length === 0,
      missingResources: [],
      errors,
    };
  }

  async run(): Promise<StageRunResult> {
    const requiresReview = this.stageRequiresReview();
    this.log("info", "AUDIT stage starting", {
      runId: this.runId,
      requiresReview,
      ventureStage: this.ventureStage ?? this.manifest.currentStage,
    });

    const summaryPath = `${getAuditsDir(this.ventureRoot)}/audit-summary-${this.runId}.json`;
    const indexEntries: ArtifactIndexEntry[] = [];
    const artifactPaths: string[] = [];
    const nowIso = new Date().toISOString();
    let reviewGateId: string | undefined;

    let result: AuditVentureResult;
    try {
      result = await auditVentureStep({
        fs: this.fs,
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        ...(this.ventureStage !== undefined ? { ventureStage: this.ventureStage } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log("error", "audit step threw", { error: message });
      try {
        await this.flushLogs();
      } catch (flushErr) {
        const m = flushErr instanceof Error ? flushErr.message : String(flushErr);
        console.warn(`stage-runners: log flush failed for AUDIT ${this.runId}: ${m}`);
      }
      return {
        success: false,
        stageName: "AUDIT",
        runId: this.runId,
        artifactsCreated: [],
        logs: [...this.logs],
        requiresReview: false,
        nextStageReady: false,
        error: {
          code: "AUDIT_STEP_THREW",
          message,
          // IO/transient errors are recoverable. The blocker-found
          // case below is NOT recoverable -- those need fixes, not
          // retries.
          recoverable: true,
        },
      };
    }

    const findings = result.findings;
    const counts = countBySeverity(findings);
    const passed = passedAudit(findings);

    this.log("info", "audit step finished", {
      status: result.status,
      total: findings.length,
      counts,
      skippedForStage: result.skippedForStage,
      passed,
    });

    // Per-finding logs (warn for high/critical, info otherwise) so the
    // JSONL trace is searchable even without re-reading the summary.
    for (const f of findings) {
      const level = f.severity === "critical" || f.severity === "high" ? "warn" : "info";
      this.log(level, `${f.severity}: ${f.ruleId} - ${f.title}`, {
        ruleId: f.ruleId,
        severity: f.severity,
      });
    }

    // Persist the canonical summary artifact regardless of pass/fail.
    const summary = {
      runId: this.runId,
      ventureId: this.manifest.id,
      passed,
      findings,
      counts,
      skippedForStage: result.skippedForStage,
      createdAt: nowIso,
    };
    try {
      await this.fs.mkdir(getAuditsDir(this.ventureRoot));
      await this.fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
      indexEntries.push({
        artifactId: `audit:summary-${this.runId}`,
        stageName: "AUDIT",
        type: "audit-summary",
        path: summaryPath,
        createdAt: nowIso,
        status: "ready",
        runId: this.runId,
      });
      artifactPaths.push(summaryPath);
      await this.appendArtifactIndex(indexEntries);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.log("warn", "failed to persist audit summary", { error: m });
      // Don't fail the run on a summary-write hiccup -- the in-memory
      // findings are still returned in the StageRunResult logs and
      // (failing case) the failed-runs dump.
    }
    artifactPaths.push(...(await this.renderBrandedPdfsForStage()));

    // Blockers present: success=false, NOT recoverable. Fix the
    // findings and re-run.
    if (!passed) {
      this.log("warn", "audit has blockers (critical/high findings)", { counts });
      try {
        await this.flushLogs();
      } catch (flushErr) {
        const m = flushErr instanceof Error ? flushErr.message : String(flushErr);
        console.warn(`stage-runners: log flush failed for AUDIT ${this.runId}: ${m}`);
      }
      return {
        success: false,
        stageName: "AUDIT",
        runId: this.runId,
        artifactsCreated: artifactPaths,
        logs: [...this.logs],
        requiresReview: false,
        nextStageReady: false,
        error: {
          code: "AUDIT_HAS_BLOCKERS",
          message: `audit found ${counts.critical} critical and ${counts.high} high findings -- see ${summaryPath}`,
          recoverable: false,
        },
      };
    }

    // Audit passed. AUDIT is in DEFAULT_REVIEW_GATES so a security
    // gate is created by default; can be disabled per-venture via
    // pipeline.reviewGates omitting "AUDIT".
    if (requiresReview) {
      const gate = this.buildReviewGate(summaryPath);
      try {
        await this.appendReviewGate(gate);
        reviewGateId = gate.gateId;
        this.log("info", "review gate created", { gateId: reviewGateId });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        this.log("warn", "failed to write review gate", { error: m });
      }
    }
    try {
      await this.flushLogs();
    } catch (flushErr) {
      const m = flushErr instanceof Error ? flushErr.message : String(flushErr);
      console.warn(`stage-runners: log flush failed for AUDIT ${this.runId}: ${m}`);
    }

    const stageResult: StageRunResult = {
      success: true,
      stageName: "AUDIT",
      runId: this.runId,
      artifactsCreated: artifactPaths,
      logs: [...this.logs],
      requiresReview,
      nextStageReady: !requiresReview,
    };
    if (reviewGateId !== undefined) stageResult.reviewGateId = reviewGateId;
    return stageResult;
  }

  private buildReviewGate(summaryPath: string): ReviewGate {
    return {
      gateId: `gate-${this.stageName}-${this.runId}`,
      stageName: this.stageName,
      runId: this.runId,
      // Audit decisions are security/compliance posture: did we accept
      // the findings the audit surfaced (e.g. "warning: regulated
      // venture not handling personal data")? Hence "security".
      requiredApproval: "security",
      status: "pending",
      createdAt: new Date().toISOString(),
      artifactsForReview: [
        { path: summaryPath, type: "audit-summary", humanReadableContent: summaryPath },
      ],
    };
  }
}
