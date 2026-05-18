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
import type { CallLlm, ResearchProvider, ResearchQuestion, RequestPasteIn } from "@founder-os/research-deep-core";
import { getAuditsDir } from "@founder-os/workspace-core";
import { gatherDeepResearch } from "../deep-research.js";
import { BaseStageRunner } from "../runner-base.js";
import type { StageRunner } from "../types.js";

type AuditFinding = AuditVentureResult["findings"][number];

const AUDIT_DEEP_RESEARCH_QUESTIONS: ResearchQuestion[] = [
  {
    id: "q-audit-owasp-top-10",
    question:
      "What are the current OWASP Top-10 web application risks and their most-cited mitigations as of right now?",
    angle: "risk",
    priority: "must",
  },
  {
    id: "q-audit-wcag-2-2",
    question:
      "Which WCAG 2.2 accessibility deltas and current must-fix issues apply to a UK SaaS product targeting this audience?",
    angle: "regulatory",
    priority: "must",
  },
  {
    id: "q-audit-uk-ico-compliance",
    question:
      "Which UK ICO / GDPR / cookie-banner / data-protection requirements are most often missed at launch right now, and how do they apply given this venture's flags (handlesPersonalData, regulated, takesPayments)?",
    angle: "regulatory",
    priority: "should",
  },
];

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
  /**
   * Gates the deep-research advisory helper. Off by default so the
   * deterministic audit path is unchanged. When on AND callLlm is set,
   * the runner gathers an "audit-current-state-advisory" briefing
   * (OWASP Top-10 + WCAG 2.2 + ICO/GDPR current state) AFTER the
   * deterministic audit step succeeds, indexes it on the artifact
   * index, and attaches it to the security review gate's
   * artifactsForReview so the reviewer sees current-best-practice
   * context alongside the deterministic findings.
   *
   * Deep-research failures are non-fatal: they log a "audit
   * deep-research skipped" warning and the audit result is unchanged.
   */
  enableDeepResearch?: boolean;
  callLlm?: CallLlm;
  requestPaste?: RequestPasteIn;
  deepResearchWorkers?: ReadonlyArray<ResearchProvider>;
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
  private readonly enableDeepResearch: boolean;
  private readonly callLlm: CallLlm | undefined;
  private readonly requestPaste: RequestPasteIn | undefined;
  private readonly deepResearchWorkers: ReadonlyArray<ResearchProvider> | undefined;

  constructor(opts: AuditStageRunnerOpts) {
    super(opts.ventureRoot, opts.fs, opts.manifest, opts.runId);
    this.ventureStage = opts.ventureStage;
    this.enableDeepResearch = opts.enableDeepResearch ?? false;
    this.callLlm = opts.callLlm;
    this.requestPaste = opts.requestPaste;
    this.deepResearchWorkers = opts.deepResearchWorkers;
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
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.log("warn", "failed to persist audit summary", { error: m });
      // Don't fail the run on a summary-write hiccup -- the in-memory
      // findings are still returned in the StageRunResult logs and
      // (failing case) the failed-runs dump.
    }

    const deepResearch = await this.gatherAuditDeepResearch();
    if (deepResearch !== null) {
      for (const path of deepResearch.artifacts) {
        indexEntries.push({
          artifactId: `audit:deep-research:${path.split("/").pop() ?? path}`,
          stageName: "AUDIT",
          type: path.endsWith(".md") ? "audit-deep-research" : "audit-deep-research-json",
          path,
          createdAt: nowIso,
          status: "ready",
          runId: this.runId,
        });
      }
      artifactPaths.push(...deepResearch.artifacts);
    }
    try {
      await this.appendArtifactIndex(indexEntries);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.log("warn", "failed to append audit artifact index", { error: m });
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
      const gate = this.buildReviewGate(summaryPath, deepResearch?.briefingMarkdownPath);
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

  private buildReviewGate(
    summaryPath: string,
    advisoryPath: string | undefined,
  ): ReviewGate {
    const artifactsForReview: ReviewGate["artifactsForReview"] = [
      { path: summaryPath, type: "audit-summary", humanReadableContent: summaryPath },
    ];
    if (advisoryPath !== undefined) {
      artifactsForReview.push({
        path: advisoryPath,
        type: "audit-deep-research",
        humanReadableContent: advisoryPath,
      });
    }
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
      artifactsForReview,
    };
  }

  private async gatherAuditDeepResearch(): Promise<{
    briefingMarkdownPath: string;
    artifacts: string[];
  } | null> {
    if (!this.enableDeepResearch || this.callLlm === undefined) return null;
    try {
      this.log("info", "audit deep-research starting", {
        topicSlug: "audit-current-state-advisory",
      });
      const result = await gatherDeepResearch({
        manifest: this.manifest,
        ventureRoot: this.ventureRoot,
        fs: this.fs,
        topic: {
          slug: "audit-current-state-advisory",
          label: "OWASP Top-10, WCAG 2.2, and UK ICO current-state advisory",
        },
        questions: AUDIT_DEEP_RESEARCH_QUESTIONS,
        ventureContext: await this.buildAuditResearchContext(),
        callLlm: this.callLlm,
        workers: this.deepResearchWorkers,
        requestPaste: this.requestPaste,
        consumers: ["AUDIT", "LAUNCH", "HANDOFF_PACK"],
        staleAfterDays: 7,
        runId: this.runId,
      });
      this.log(result.fromCache ? "info" : "info", result.fromCache ? "audit deep-research cache-hit" : "audit deep-research ready", {
        topicSlug: result.briefing.topicSlug,
        channelsUsed: result.briefing.channelsUsed,
        sources: result.briefing.sources.length,
      });
      const artifacts = result.artifactsCreated.filter((path) => path.endsWith(".md") || path.endsWith(".json"));
      // Briefing markdown is what the reviewer reads alongside the audit
      // summary. persistDeepResearchRun always writes it as
      // <ventureRoot>/00_research/deep/briefings/<slug>.md so the .md
      // entry is reliably present in artifacts.
      const briefingMarkdownPath =
        artifacts.find((path) => path.endsWith(`${result.briefing.topicSlug}.md`)) ?? artifacts[0] ?? "";
      return { briefingMarkdownPath, artifacts };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log("warn", "audit deep-research skipped", { error: message });
      return null;
    }
  }

  private async buildAuditResearchContext(): Promise<string> {
    const parts = [
      `Venture: ${this.manifest.name}`,
      `App type: ${this.manifest.appType}`,
      this.manifest.industry ? `Industry: ${this.manifest.industry}` : "",
      this.manifest.entityType ? `Entity type: ${this.manifest.entityType}` : "",
      `Flags: takesPayments=${this.manifest.takesPayments}, regulated=${this.manifest.regulated}, handlesPersonalData=${this.manifest.handlesPersonalData}, hiresStaff=${this.manifest.hiresStaff}`,
      `Current stage at audit time: ${this.ventureStage ?? this.manifest.currentStage}`,
    ].filter(Boolean);
    const intakePath = `${this.ventureRoot}/00_research/intake.md`;
    if (await this.fs.exists(intakePath)) {
      try {
        const intake = await this.fs.readFile(intakePath);
        if (intake.trim()) parts.push(`Founder intake:\n${excerptMarkdown(intake, 1600)}`);
      } catch {
        // Manifest context is enough to proceed.
      }
    }
    return parts.join("\n\n");
  }
}

function excerptMarkdown(markdown: string, maxChars: number): string {
  const trimmed = markdown.trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}\n\n...[truncated]` : trimmed;
}
