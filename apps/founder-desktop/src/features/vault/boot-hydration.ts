/**
 * Boot-time recovery for the Dream Vault.
 *
 * Two hydration strategies, layered:
 *
 *   1. `hydrateResumableVaultJobs()` (resumable-imports arc) -- when
 *      drafts / matches / items were persisted at the end of the
 *      original run, this rebuilds a full `PendingVaultImport`
 *      complete with a Tauri-backed `finalize` callback. Recovered
 *      entries are truly reviewable across reloads.
 *
 *   2. `hydrateRecoveredVaultJobs()` (Rust IPC slice 4) -- the
 *      legacy fallback. Returns `RecoveredVaultImport` entries that
 *      can only be discarded because their runner state wasn't
 *      persisted. Catches pre-resumable-arc jobs + any job where
 *      slice-B2 persistence failed mid-run.
 *
 * App.tsx prefers the resumable path; jobs that come back with zero
 * drafts fall through to the recovered map.
 *
 * Graceful degrade: if the Rust IPC isn't wired in this dev build,
 * `safeInvoke` returns null and both strategies return empty maps.
 * The boot effect in App.tsx is fire-and-forget; failures don't gate
 * the UI.
 */
import type {
  Confidence,
  ExtractedItem,
  ImportJob,
  ProjectMatch,
  SourceDocument,
  VaultNoteFrontmatter,
  VaultNoteType,
} from "@founder-os/vault-contract";
import type {
  VaultFinalizeInput,
  VaultFinalizeResult,
  VaultNoteDraft,
  VaultRunResult,
  VaultSourceProcessing,
} from "@founder-os/vault-runner";
import {
  VAULT_TEMPLATE_VERSION,
  resolveVaultNotePath,
  toWorkspaceRelative,
  writeVaultNote,
} from "@founder-os/markdown-vault";
import { invoke } from "@tauri-apps/api/core";

import type { RunVaultImportResult, VaultImportSourceInput } from "./run-vault-import.js";
import { createTauriFsPort } from "./tauri-fs-port.js";
import type { PendingVaultImport, RecoveredVaultImport } from "./types.js";

type VaultListJobsRow = {
  id: string;
  status: string;
  sourceProvider: string;
  sourceMode: string;
  fileCount: number;
  processedCount: number;
  failedCount: number;
  warningCount: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Match Tauri's "command not registered" errors only. Predicate
 * shape mirrors `isCommandNotRegisteredError` in run-vault-import.ts
 * (see that file for the originating bug report): require both the
 * command name and a not-registered phrase, otherwise legitimate
 * runtime errors from a registered command degrade silently.
 */
function isCommandNotRegisteredError(err: unknown, command: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (!message.toLowerCase().includes(command.toLowerCase())) return false;
  return (
    /\bnot\s+(found|registered|allowed|defined)\b/i.test(message) ||
    /\bunknown\s+command\b/i.test(message) ||
    /\bisn'?t\s+defined\b/i.test(message)
  );
}

async function safeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    if (isCommandNotRegisteredError(err, command)) {
      console.warn(`[vault-boot-hydration] Tauri command "${command}" not registered; skipping`);
      return null;
    }
    console.error(`[vault-boot-hydration] ${command} failed:`, err);
    throw err;
  }
}

/**
 * Pull all jobs in `needs_review` status + their source rows. Returns
 * a Map keyed by jobId so the App can splice it into its existing
 * recoveredVaultImports state without further transformation.
 */
export async function hydrateRecoveredVaultJobs(): Promise<Map<string, RecoveredVaultImport>> {
  const out = new Map<string, RecoveredVaultImport>();

  const jobs = await safeInvoke<VaultListJobsRow[]>("vault_list_jobs", {
    status: "needs_review",
    limit: 50,
  });
  if (!jobs) return out;

  for (const job of jobs) {
    const sources = await safeInvoke<SourceDocument[]>("vault_list_sources_for_job", {
      jobId: job.id,
    });
    out.set(job.id, {
      jobId: job.id,
      status: job.status,
      sourceProvider: job.sourceProvider,
      sourceMode: job.sourceMode,
      fileCount: job.fileCount,
      processedCount: job.processedCount,
      failedCount: job.failedCount,
      warningCount: job.warningCount,
      sources: sources ?? [],
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  }

  return out;
}

/**
 * Hard-delete a job + its source documents from SQLite. Used by the
 * pending-imports panel's Discard action for recovered entries.
 *
 * Returns true on success, false on degraded mode (Rust command not
 * registered). The caller still drops the entry from local state on
 * either path — there's no point preserving a recovered entry the
 * user explicitly discarded.
 */
export async function discardRecoveredVaultJob(jobId: string): Promise<boolean> {
  try {
    await invoke<void>("vault_discard_job", { jobId });
    return true;
  } catch (err) {
    if (isCommandNotRegisteredError(err, "vault_discard_job")) {
      console.warn(`[vault-boot-hydration] vault_discard_job not registered; clearing local only`);
      return false;
    }
    throw err;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Resumable-imports arc: full PendingVaultImport reconstruction.
// ────────────────────────────────────────────────────────────────────────────

/** Wire shape returned by `vault_list_note_drafts_for_job`. */
type PersistedDraft = {
  id: string;
  importJobId: string;
  sourceDocumentId: string;
  noteType: VaultNoteType;
  suggestedVentureSlug: string | null;
  title: string;
  previewContent: string;
  previewFrontmatterJson: string;
  itemIdsJson: string;
  tagsJson: string;
  confidence: Confidence | null;
  variablesJson: string;
  createdAt: string;
  /**
   * VAULT_TEMPLATE_VERSION at persist time. Drafts inserted before
   * migration 0014 default to 1 via the schema's DEFAULT clause.
   * Boot hydration compares against the runtime constant; mismatch
   * forces a re-render at finalize time, bypassing the byte-copy
   * fast path.
   */
  templateVersion: number;
};

/** Wire shape returned by `vault_get_job` / `vault_list_jobs`. */
type PersistedJob = ImportJob;

/**
 * Build a `PendingVaultImport` from the persisted SQLite rows. The
 * resulting object lacks a live `runner` instance (resumed entries
 * have no live LLM caller / extractor ports / fs port) but supplies
 * a Tauri-backed `finalize()` that uses `resolveVaultNotePath` +
 * the desktop's existing `write_file` / `mkdir_p` commands to commit.
 */
export async function hydrateResumableVaultJobs(opts: {
  /** Workspace root used to resolve note paths at commit time. */
  workspaceRoot: string;
}): Promise<{
  resumable: Map<string, PendingVaultImport>;
  /** Jobs with no persisted drafts -- fall through to discard-only. */
  legacyRecovered: Map<string, RecoveredVaultImport>;
}> {
  const resumable = new Map<string, PendingVaultImport>();
  const legacyRecovered = new Map<string, RecoveredVaultImport>();

  const jobs = await safeInvoke<PersistedJob[]>("vault_list_jobs", {
    status: "needs_review",
    limit: 50,
  });
  if (!jobs) return { resumable, legacyRecovered };

  for (const job of jobs) {
    const [sources, matches, items, drafts] = await Promise.all([
      safeInvoke<SourceDocument[]>("vault_list_sources_for_job", { jobId: job.id }),
      safeInvoke<ProjectMatch[]>("vault_list_project_matches_for_job", { jobId: job.id }),
      safeInvoke<ExtractedItem[]>("vault_list_extracted_items_for_job", { jobId: job.id }),
      safeInvoke<PersistedDraft[]>("vault_list_note_drafts_for_job", { jobId: job.id }),
    ]);

    const draftList = drafts ?? [];
    if (draftList.length === 0) {
      // No drafts persisted -- pre-resumable-arc job or a run that
      // failed before persistence. Surface as legacy recovered.
      legacyRecovered.set(job.id, {
        jobId: job.id,
        status: job.status,
        sourceProvider: job.sourceProvider,
        sourceMode: job.sourceMode,
        fileCount: job.fileCount,
        processedCount: job.processedCount,
        failedCount: job.failedCount,
        warningCount: job.warningCount,
        sources: sources ?? [],
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      });
      continue;
    }

    const sourcesList = sources ?? [];
    const matchesByDoc = bucketByKey(matches ?? [], (m) => m.sourceDocumentId);
    const itemsByDoc = bucketByKey(items ?? [], (i) => i.sourceDocumentId);
    const reconstructedDrafts = draftList.map(rehydrateDraft);
    // Parallel map keyed by noteId so resumedFinalize can dispatch
    // on stale-template detection without polluting the
    // VaultNoteDraft contract from @founder-os/vault-runner.
    const templateVersionByNoteId = new Map<string, number>(
      draftList.map((d) => [d.id, d.templateVersion ?? 1] as const)
    );

    // Rebuild the per-source array. Drafts/matches/items belong to a
    // source via foreign key; assemble them under each row.
    const perSource: VaultSourceProcessing[] = sourcesList.map((source) => ({
      source,
      markdown: "",
      extraction: { kind: "skipped" },
      drafts: reconstructedDrafts.filter((d) => d.sourceDocumentId === source.id),
    }));

    const run: VaultRunResult = {
      jobId: job.id,
      status: "needs_review",
      perSource,
      matches: matchesByDoc,
      items: itemsByDoc,
      drafts: reconstructedDrafts,
      logs: [],
      warnings: [],
    };

    const result: RunVaultImportResult = {
      job,
      run,
      llmConfigured: false,
      finalize: (input) =>
        resumedFinalize({
          input,
          job,
          drafts: reconstructedDrafts,
          templateVersionByNoteId,
          workspaceRoot: opts.workspaceRoot,
        }),
    };

    // Reconstruct a thin VaultImportSourceInput list off the source
    // rows so the panel's "N sources" label keeps working.
    const sourceInputs: VaultImportSourceInput[] = sourcesList.map((s) => ({
      absolutePath: s.cachedOriginalPath,
      originalName: s.originalName,
      sourceType: s.sourceType,
      ...(s.fileExtension ? { fileExtension: s.fileExtension } : {}),
      ...(s.mimeType ? { mimeType: s.mimeType } : {}),
      ...(s.byteSize !== undefined ? { byteSize: s.byteSize } : {}),
    }));

    resumable.set(job.id, {
      jobId: job.id,
      result,
      sources: sourceInputs,
      llmConfigured: false,
      readyAt: job.updatedAt,
    });
  }

  return { resumable, legacyRecovered };
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers for the resumable path
// ────────────────────────────────────────────────────────────────────────────

function bucketByKey<T>(
  rows: T[],
  keyFn: (row: T) => string
): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const row of rows) {
    const k = keyFn(row);
    (out[k] ?? (out[k] = [])).push(row);
  }
  return out;
}

function rehydrateDraft(row: PersistedDraft): VaultNoteDraft {
  const draft: VaultNoteDraft = {
    noteId: row.id,
    noteType: row.noteType,
    sourceDocumentId: row.sourceDocumentId,
    suggestedVentureSlug: row.suggestedVentureSlug,
    title: row.title,
    previewContent: row.previewContent,
    previewFrontmatter: safeParseJson<VaultNoteFrontmatter>(
      row.previewFrontmatterJson,
      defaultFrontmatter(row)
    ),
    itemIds: safeParseJson<string[]>(row.itemIdsJson, []),
    tags: safeParseJson<string[]>(row.tagsJson, []),
    variables: safeParseJson<Record<string, unknown>>(row.variablesJson, {}),
  };
  if (row.confidence) draft.confidence = row.confidence;
  return draft;
}

function defaultFrontmatter(row: PersistedDraft): VaultNoteFrontmatter {
  return {
    title: row.title,
    sourceDocumentId: row.sourceDocumentId,
    projectSlug: row.suggestedVentureSlug,
    noteType: row.noteType,
    tags: [],
    itemIds: [],
    createdAt: row.createdAt,
  };
}

function safeParseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Resumed-finalize implementation. Walks the persisted drafts, writes
 * the approved ones via the desktop's `mkdir_p` + `write_file`
 * commands at the path `resolveVaultNotePath` computes, then flips
 * the job row to `committed` via `vault_update_job_status`.
 *
 * Mirrors `VaultStageRunner.finalize` minus the template re-rendering
 * step -- the persisted `previewContent` already carries the rendered
 * markdown, so we write it byte-for-byte. (Re-rendering with a
 * possibly-different venture slug is a follow-up; today's resumed
 * finalize commits with whatever slug the reviewer picks but the
 * frontmatter inside the note body still reflects the original
 * suggested slug.)
 */
async function resumedFinalize(opts: {
  input: VaultFinalizeInput;
  job: ImportJob;
  drafts: VaultNoteDraft[];
  /** noteId -> template_version at persist time. Drafts with a
   *  version != VAULT_TEMPLATE_VERSION get re-rendered at commit
   *  time even when the slug matches the suggestion, so the
   *  committed markdown reflects the runtime templates rather than
   *  whatever the templates looked like when the draft was persisted. */
  templateVersionByNoteId: Map<string, number>;
  workspaceRoot: string;
}): Promise<VaultFinalizeResult> {
  const { input, job, drafts, templateVersionByNoteId, workspaceRoot } = opts;
  const approvalsBySource = new Map(
    input.approvals.map((a) => [a.sourceDocumentId, a] as const)
  );
  const notesWritten: VaultFinalizeResult["notesWritten"] = [];
  const warnings: string[] = [];
  let skippedCount = 0;

  const fsPort = createTauriFsPort();

  for (const draft of drafts) {
    const approval = approvalsBySource.get(draft.sourceDocumentId);
    if (!approval) {
      skippedCount += 1;
      continue;
    }
    if (approval.acceptedNoteIds && !approval.acceptedNoteIds.includes(draft.noteId)) {
      skippedCount += 1;
      continue;
    }
    try {
      // Fast-path predicate has two clauses, both must hold:
      //
      //   1. Slug-equality. When the reviewer picks the same slug the
      //      classifier suggested, the persisted `previewContent`'s
      //      frontmatter slug is already correct. Different slug ->
      //      re-render so the frontmatter reflects the new slug.
      //
      //   2. Template-version-equality. If VAULT_TEMPLATE_VERSION has
      //      bumped since this draft was persisted, the previewContent
      //      reflects the OLD template's output and committing it
      //      byte-for-byte would drift the vault away from the current
      //      template engine's canonical output. Force re-render.
      //
      // The re-render branch handles both cases identically because
      // writeVaultNote always renders from `variables` against the
      // runtime templates -- whichever clause failed, the output is
      // the same as what an in-session finalize would have produced.
      const slugMatchesSuggestion =
        approval.ventureSlug === (draft.suggestedVentureSlug ?? null);
      const persistedTemplateVersion = templateVersionByNoteId.get(draft.noteId) ?? 1;
      const templateUpToDate = persistedTemplateVersion === VAULT_TEMPLATE_VERSION;
      if (slugMatchesSuggestion && templateUpToDate) {
        const absolutePath = resolveVaultNotePath({
          workspaceRoot,
          ventureSlug: approval.ventureSlug,
          noteType: draft.noteType,
          noteId: draft.noteId,
        });
        const dir = absolutePath.replace(/[\\/][^\\/]+$/, "");
        await invoke<void>("mkdir_p", { path: dir });
        await invoke<void>("write_file", { path: absolutePath, content: draft.previewContent });
        const relativePath = toWorkspaceRelative(workspaceRoot, absolutePath);
        notesWritten.push({
          noteId: draft.noteId,
          sourceDocumentId: draft.sourceDocumentId,
          ventureSlug: approval.ventureSlug,
          absolutePath,
          relativePath,
        });
      } else {
        // Re-render with the new slug. writeVaultNote rebuilds the
        // frontmatter + body from the persisted draft.variables; we
        // bring along the title / sourceDocumentId / itemIds / tags /
        // confidence the original run captured so the re-render matches
        // the in-session output byte-for-byte except for the slug fields.
        const res = await writeVaultNote(
          {
            workspaceRoot,
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
          fsPort
        );
        notesWritten.push({
          noteId: draft.noteId,
          sourceDocumentId: draft.sourceDocumentId,
          ventureSlug: approval.ventureSlug,
          absolutePath: res.absolutePath,
          relativePath: res.relativePath,
        });
        for (const w of res.warnings) {
          warnings.push(`note ${draft.noteId}: ${w}`);
        }
        if (res.unresolvedPlaceholders.length > 0) {
          warnings.push(
            `note ${draft.noteId}: unresolved placeholders: ${res.unresolvedPlaceholders.join(", ")}`
          );
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`note ${draft.noteId}: write failed: ${message}`);
    }
  }

  // Flip the job row to committed. Best-effort -- if the Rust command
  // is missing we still return the writes we did (the markdown is on
  // disk; only the job-status update fails).
  try {
    await invoke<void>("vault_update_job_status", {
      jobId: job.id,
      status: "committed",
      errorMessage: null,
      now: input.now,
    });
  } catch (err) {
    warnings.push(
      `vault_update_job_status failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Drop the transient drafts/matches/items rows now that the
  // markdown is safely on disk + the job is `committed`. Status-
  // guarded server-side so a partial finalize (where
  // vault_update_job_status failed above) leaves the rows in place
  // for a retry. Best-effort: failures don't roll back the commit.
  try {
    await invoke<void>("vault_cleanup_committed_job_support", { jobId: job.id });
  } catch (err) {
    warnings.push(
      `vault_cleanup_committed_job_support failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return {
    jobId: job.id,
    status: "committed",
    notesWritten,
    skippedCount,
    logs: [],
    warnings,
  };
}
