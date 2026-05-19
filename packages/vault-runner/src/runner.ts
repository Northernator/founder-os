/**
 * Slice 8 -- VaultStageRunner.
 *
 * Mirrors the MediaStageRunner / HandoffPackStageRunner shape (class
 * with `validate()` + `run()`) but adds a separate `finalize()`
 * because the Dream Vault import has a mandatory human-review gate
 * between phases 8 and 9. Drafts produced by `run()` are held
 * in-memory; `finalize()` is what writes them to disk after the
 * reviewer's approvals come in.
 *
 * The runner never imports a provider SDK -- callLlm is the boundary.
 * Filesystem touch points are mediated by the injected VaultFsPort.
 */
import { commitImportJob } from "@founder-os/import-core";
import type { ImportJobStore } from "@founder-os/import-core";
import type {
  ExtractedItem,
  ProjectMatch,
} from "@founder-os/vault-contract";
import { writeVaultNote } from "@founder-os/markdown-vault";
import { pickBestVentureSlug } from "./classify-stage.js";
import { runClassifyStage } from "./classify-stage.js";
import { dispatchExtraction, summariseExtractionCounts } from "./extract-stage.js";
import { runKnowledgeStage } from "./knowledge-stage.js";
import { VAULT_LOG_STRINGS } from "./log-strings.js";
import { buildDraftsForSource } from "./notes-stage.js";
import {
  type VaultFinalizeInput,
  type VaultFinalizeResult,
  type VaultLogEntry,
  type VaultLogLevel,
  type VaultNoteDraft,
  type VaultRunResult,
  type VaultRunnerOpts,
  type VaultSourceProcessing,
  VaultRunnerError,
} from "./types.js";

function generateRunId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

export class VaultStageRunner {
  readonly stageName = "VAULT_IMPORT";
  private readonly opts: VaultRunnerOpts;
  private readonly logs: VaultLogEntry[] = [];
  readonly runId: string;
  /** Lazily populated by `run()`; consumed by `finalize()`. */
  private lastRun: VaultRunResult | null = null;

  constructor(opts: VaultRunnerOpts) {
    this.opts = opts;
    this.runId = opts.runId ?? generateRunId();
  }

  // -------------------------------------------------------------------------
  // Logging helpers
  // -------------------------------------------------------------------------

  private nowIso(): string {
    return this.opts.nowFn ? this.opts.nowFn() : new Date().toISOString();
  }

  private log(level: VaultLogLevel, message: string, data?: Record<string, unknown>): void {
    const entry: VaultLogEntry = { timestamp: this.nowIso(), level, message };
    if (data !== undefined) entry.data = data;
    this.logs.push(entry);
    // Mirror the runner log into the structured import-core logger so
    // the desktop's central log tail sees it. We intentionally use a
    // namespaced event name so it doesn't collide with import-core's
    // own events.
    const fields = { ...(data ?? {}), message };
    if (level === "info") this.opts.logger.info("vault-runner.event", fields);
    else if (level === "warn") this.opts.logger.warn("vault-runner.event", fields);
    else this.opts.logger.error("vault-runner.event", fields);
  }

  // -------------------------------------------------------------------------
  // validate()
  // -------------------------------------------------------------------------

  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (this.opts.job.status !== "needs_review" && this.opts.job.status !== "processing") {
      errors.push(
        `vault-runner: job must be in needs_review/processing status, got ${this.opts.job.status}`
      );
    }
    if (this.opts.sources.length === 0) {
      errors.push("vault-runner: at least one staged source is required");
    }
    return { valid: errors.length === 0, errors };
  }

  // -------------------------------------------------------------------------
  // run()
  // -------------------------------------------------------------------------

  async run(): Promise<VaultRunResult> {
    const v = this.validate();
    if (!v.valid) {
      const code = "VAULT_VALIDATE_FAILED";
      const message = v.errors.join("; ");
      this.log("error", "Vault import validation failed", { errors: v.errors });
      return {
        jobId: this.opts.job.id,
        status: "failed",
        perSource: [],
        matches: {},
        items: {},
        drafts: [],
        logs: [...this.logs],
        warnings: [],
        error: { code, message },
      };
    }

    this.log("info", VAULT_LOG_STRINGS.starting, {
      runId: this.runId,
      jobId: this.opts.job.id,
      sourceCount: this.opts.sources.length,
      withLlm: this.opts.callLlm !== undefined,
      candidateCount: this.opts.candidates.length,
    });

    const aggregatedWarnings: string[] = [];

    try {
      // Phases 1-2 are confirmation-only -- processImportJob already did
      // the work. Logging them keeps the desktop's deriveSteps helper
      // happy (it pattern-matches the 9 spec phase strings).
      this.log("info", VAULT_LOG_STRINGS.copying, {
        fileCount: this.opts.job.fileCount,
      });
      const byType = countBySourceType(this.opts.sources);
      this.log("info", VAULT_LOG_STRINGS.detecting, byType);

      // Phase 3-5: extraction (one dispatch per source). Failed
      // extractions are recorded on the per-source row + a "Vault
      // source failed" warning fires; the loop keeps going.
      const perSource = await this.runExtractPhase();
      const extractCounts = summariseExtractionCounts(perSource);
      this.log("info", VAULT_LOG_STRINGS.extractingText, {
        documents: extractCounts.documents,
        failed: extractCounts.failed,
        skipped: extractCounts.skipped,
      });
      this.log("info", VAULT_LOG_STRINGS.analysingImages, {
        images: extractCounts.images,
      });
      this.log("info", VAULT_LOG_STRINGS.parsingChats, {
        chats: extractCounts.chats,
      });
      for (const p of perSource) {
        if (p.extraction.kind === "failed") {
          this.log("warn", VAULT_LOG_STRINGS.sourceFailed, {
            sourceId: p.source.id,
            originalName: p.source.originalName,
            error: p.extraction.error,
          });
          aggregatedWarnings.push(
            `source ${p.source.id} (${p.source.originalName}): extraction failed: ${p.extraction.error}`
          );
        }
      }

      // Phase 6: classify.
      const now = this.nowIso();
      const classify = await runClassifyStage({
        perSource,
        candidates: this.opts.candidates,
        ...(this.opts.callLlm ? { callLlm: this.opts.callLlm } : {}),
        now,
      });
      aggregatedWarnings.push(...classify.warnings);
      const matches: Record<string, ProjectMatch[]> = classify.byId;
      const suggestedIds: Record<string, string | null> = {};
      for (const p of perSource) {
        const m = matches[p.source.id] ?? [];
        const slug = pickBestVentureSlug(m, this.opts.candidates);
        const candidate = slug
          ? this.opts.candidates.find((c) => c.slug === slug)
          : undefined;
        suggestedIds[p.source.id] = candidate?.projectId ?? null;
      }
      this.log("info", VAULT_LOG_STRINGS.classifying, {
        classified: Object.values(matches).filter((m) => m.length > 0).length,
        warnings: classify.warnings.length,
      });

      // Phase 7: knowledge.
      const knowledge = await runKnowledgeStage({
        perSource,
        suggestedProjectIds: suggestedIds,
        ...(this.opts.callLlm ? { callLlm: this.opts.callLlm } : {}),
        now,
      });
      aggregatedWarnings.push(...knowledge.warnings);
      const items: Record<string, ExtractedItem[]> = knowledge.byId;
      const totalItems = Object.values(items).reduce((acc, arr) => acc + arr.length, 0);
      this.log("info", VAULT_LOG_STRINGS.extractingKnowledge, {
        totalItems,
        warnings: knowledge.warnings.length,
      });

      // Phase 8: drafts.
      const allDrafts: VaultNoteDraft[] = [];
      for (const p of perSource) {
        if (p.extraction.kind === "failed" || p.extraction.kind === "skipped") {
          continue;
        }
        const drafts = buildDraftsForSource({
          source: p,
          items: items[p.source.id] ?? [],
          candidates: this.opts.candidates,
          workspaceRoot: this.opts.workspaceRoot,
          now,
        });
        allDrafts.push(...drafts);
      }
      this.log("info", VAULT_LOG_STRINGS.generatingDrafts, {
        draftCount: allDrafts.length,
      });

      // Phase 9: ready.
      this.log("info", VAULT_LOG_STRINGS.readyForReview, {
        draftCount: allDrafts.length,
        warningCount: aggregatedWarnings.length,
      });

      const result: VaultRunResult = {
        jobId: this.opts.job.id,
        status: "needs_review",
        perSource,
        matches,
        items,
        drafts: allDrafts,
        logs: [...this.logs],
        warnings: aggregatedWarnings,
      };
      this.lastRun = result;
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = "VAULT_RUNNER_THREW";
      this.log("error", "Vault import threw", { code, error: message });
      return {
        jobId: this.opts.job.id,
        status: "failed",
        perSource: [],
        matches: {},
        items: {},
        drafts: [],
        logs: [...this.logs],
        warnings: aggregatedWarnings,
        error: { code, message },
      };
    }
  }

  // -------------------------------------------------------------------------
  // finalize()
  // -------------------------------------------------------------------------

  async finalize(input: VaultFinalizeInput): Promise<VaultFinalizeResult> {
    if (this.lastRun === null) {
      throw new VaultRunnerError(
        "VAULT_FINALIZE_BEFORE_RUN",
        "vault-runner: finalize() called before run() completed successfully"
      );
    }
    if (this.lastRun.status !== "needs_review") {
      throw new VaultRunnerError(
        "VAULT_FINALIZE_INVALID_STATE",
        `vault-runner: finalize() requires status needs_review, got ${this.lastRun.status}`
      );
    }

    this.log("info", VAULT_LOG_STRINGS.finalising, {
      jobId: this.opts.job.id,
      approvalCount: input.approvals.length,
    });

    const approvalsBySourceId = new Map(input.approvals.map((a) => [a.sourceDocumentId, a]));
    const notesWritten: VaultFinalizeResult["notesWritten"] = [];
    const warnings: string[] = [];
    let skippedCount = 0;

    for (const draft of this.lastRun.drafts) {
      const approval = approvalsBySourceId.get(draft.sourceDocumentId);
      if (!approval) {
        skippedCount += 1;
        continue;
      }
      if (approval.acceptedNoteIds && !approval.acceptedNoteIds.includes(draft.noteId)) {
        skippedCount += 1;
        continue;
      }
      try {
        const result = await writeVaultNote(
          {
            workspaceRoot: this.opts.workspaceRoot,
            ventureSlug: approval.ventureSlug,
            noteType: draft.noteType,
            noteId: draft.noteId,
            title: draft.title,
            sourceDocumentId: draft.sourceDocumentId,
            itemIds: draft.itemIds,
            tags: draft.tags,
            ...(draft.confidence ? { confidence: draft.confidence } : {}),
            now: input.now,
            variables: draft.variables,
          },
          this.opts.vaultFs
        );
        notesWritten.push({
          noteId: draft.noteId,
          sourceDocumentId: draft.sourceDocumentId,
          ventureSlug: approval.ventureSlug,
          absolutePath: result.absolutePath,
          relativePath: result.relativePath,
        });
        for (const w of result.warnings) {
          warnings.push(`note ${draft.noteId}: ${w}`);
        }
        if (result.unresolvedPlaceholders.length > 0) {
          warnings.push(
            `note ${draft.noteId}: unresolved placeholders: ${result.unresolvedPlaceholders.join(", ")}`
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log("error", "Vault note write failed", {
          noteId: draft.noteId,
          error: message,
        });
        return {
          jobId: this.opts.job.id,
          status: "failed",
          notesWritten,
          skippedCount,
          logs: [...this.logs],
          warnings,
          error: { code: "VAULT_NOTE_WRITE_FAILED", message },
        };
      }
    }

    this.log("info", VAULT_LOG_STRINGS.notesWritten, {
      notesWritten: notesWritten.length,
      skipped: skippedCount,
    });

    if (this.opts.store) {
      try {
        await commitImportJob({
          job: this.opts.job,
          store: this.opts.store,
          logger: this.opts.logger,
          ...(this.opts.emit ? { emit: this.opts.emit } : {}),
          now: input.now,
        });
      } catch (err) {
        // commitImportJob's failure does not invalidate the notes already
        // on disk -- surface the warning but keep status committed.
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(`commitImportJob failed: ${message}`);
      }
    } else {
      warnings.push(
        "finalize: no ImportJobStore provided -- caller is responsible for committing the job row"
      );
    }

    this.log("info", VAULT_LOG_STRINGS.committed, {
      jobId: this.opts.job.id,
      notesWritten: notesWritten.length,
    });

    return {
      jobId: this.opts.job.id,
      status: "committed",
      notesWritten,
      skippedCount,
      logs: [...this.logs],
      warnings,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async runExtractPhase(): Promise<VaultSourceProcessing[]> {
    const out: VaultSourceProcessing[] = [];
    for (const doc of this.opts.sources) {
      const result = await dispatchExtraction({
        doc,
        workspaceRoot: this.opts.workspaceRoot,
        resolveCachedPath: this.opts.resolveCachedPath,
        extractDocument: this.opts.extractDocument,
        extractImage: this.opts.extractImage,
        extractChat: this.opts.extractChat,
        ...(this.opts.ocrEngine ? { ocrEngine: this.opts.ocrEngine } : {}),
        ...(this.opts.visionCallLlm ? { visionCallLlm: this.opts.visionCallLlm } : {}),
      });
      out.push(result);
    }
    return out;
  }
}

function countBySourceType(sources: VaultRunnerOpts["sources"]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sources) {
    out[s.sourceType] = (out[s.sourceType] ?? 0) + 1;
  }
  return out;
}
