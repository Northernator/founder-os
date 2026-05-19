//! Dream Vault SQLite job store — slice 1 of the Rust IPC arc.
//!
//! The TypeScript renderer treats vault imports as transient until this
//! module ships. `apps/founder-desktop/src/features/vault/
//! run-vault-import.ts` keeps the job + sources in a `Map` keyed by job
//! id, which means a reload during a pending review drops every draft.
//! These commands give the renderer a real persistence layer keyed on
//! the same primary keys the TS `ImportJobStore` interface declares
//! (see `packages/import-core/src/ports.ts`).
//!
//! Seven commands:
//!
//!   vault_create_job(job) -> ()                — INSERT a new row.
//!   vault_update_job_status(id, status, error?) -> ()
//!   vault_get_job(id) -> ImportJob | null
//!   vault_increment_job_counts(id, delta) -> () — additive update for
//!       processedCount / failedCount / warningCount / fileCount.
//!   vault_insert_source(doc) -> ()             — INSERT a SourceDocument.
//!   vault_list_sources_for_job(id) -> [SourceDocument]
//!   vault_list_jobs(status?) -> [ImportJob]    — newest-first; optional
//!       status filter for the slice-4 boot hydration that surfaces
//!       pending-review imports on app start.
//!
//! Naming + scope:
//!   - The `vault_db_*` prefix was considered but the SHIP-NOTES
//!     carry-over already named these `vault_create_job` etc; keeping
//!     them stable avoids a second TS-side rename.
//!   - These commands cover only vault_import_jobs +
//!     vault_source_documents. The other seven tables in migration 0012
//!     (extractions / images / matches / items / notes / connections /
//!     import_sources) get IPC in later slices when their writers and
//!     readers actually exist (currently rendered from in-memory state).
//!
//! Persistence pattern mirrors brand_names.rs / cache.rs: lazy
//! Mutex<Option<Connection>>, WAL on first open, separate connection
//! from tauri-plugin-sql's pool (SQLite handles intra-process
//! concurrency via WAL).

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State};

#[derive(Default)]
pub struct VaultState {
    conn: Mutex<Option<Connection>>,
}

// ────────────────────────────────────────────────────────────────────────────
// Wire types — mirror @founder-os/vault-contract zod schemas.
// camelCase serde so the WebView side reads them straight into the existing
// SourceDocument / ImportJob TypeScript types.
// ────────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportJob {
    pub id: String,
    pub status: String,
    pub source_provider: String,
    pub source_mode: String,
    pub file_count: i64,
    pub processed_count: i64,
    pub failed_count: i64,
    pub warning_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// Schema version literal — TS expects it but it isn't stored in the DB.
    #[serde(default = "schema_v1")]
    pub schema_version: u8,
}

fn schema_v1() -> u8 {
    1
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDocument {
    pub id: String,
    pub import_job_id: String,
    pub source_type: String,
    pub source_provider: String,
    pub original_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_extension: Option<String>,
    pub cached_original_path: String,
    pub content_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byte_size: Option<i64>,
    pub extraction_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extraction_method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<String>,
    pub needs_review: bool,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imported_at: Option<String>,
    #[serde(default = "schema_v1")]
    pub schema_version: u8,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CountDelta {
    pub processed_count: Option<i64>,
    pub failed_count: Option<i64>,
    pub warning_count: Option<i64>,
    pub file_count: Option<i64>,
}

// ────────────────────────────────────────────────────────────────────────────
// Connection plumbing — same lazy-WAL pattern as brand_names.rs / cache.rs.
// ────────────────────────────────────────────────────────────────────────────

fn resolve_db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolve app_config_dir: {e}"))?;
    Ok(dir.join("founder.db"))
}

fn with_conn<R, F>(
    state: &State<'_, VaultState>,
    app: &tauri::AppHandle,
    f: F,
) -> Result<R, String>
where
    F: FnOnce(&Connection) -> Result<R, String>,
{
    let mut guard = state
        .conn
        .lock()
        .map_err(|_| "vault mutex poisoned".to_string())?;
    if guard.is_none() {
        let path = resolve_db_path(app)?;
        let conn = Connection::open(&path)
            .map_err(|e| format!("open vault db at {}: {}", path.display(), e))?;
        // WAL is sticky on disk; re-applying on each open is a no-op.
        // Required so the vault writes don't contend with the
        // tauri-plugin-sql pool that the rest of the app uses.
        let _: String = conn
            .query_row("PRAGMA journal_mode=WAL;", [], |r| r.get(0))
            .map_err(|e| format!("set WAL: {e}"))?;
        *guard = Some(conn);
    }
    let conn = guard.as_ref().expect("connection just initialised");
    f(conn)
}

// ────────────────────────────────────────────────────────────────────────────
// Row → wire-type mappers.
// ────────────────────────────────────────────────────────────────────────────

fn row_to_job(row: &Row<'_>) -> rusqlite::Result<ImportJob> {
    Ok(ImportJob {
        id: row.get("id")?,
        status: row.get("status")?,
        source_provider: row.get("source_provider")?,
        source_mode: row.get("source_mode")?,
        file_count: row.get("file_count")?,
        processed_count: row.get("processed_count")?,
        failed_count: row.get("failed_count")?,
        warning_count: row.get("warning_count")?,
        error_message: row.get("error_message")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        schema_version: 1,
    })
}

fn row_to_source(row: &Row<'_>) -> rusqlite::Result<SourceDocument> {
    let needs_review_int: i64 = row.get("needs_review")?;
    Ok(SourceDocument {
        id: row.get("id")?,
        import_job_id: row.get("import_job_id")?,
        source_type: row.get("source_type")?,
        source_provider: row.get("source_provider")?,
        original_name: row.get("original_name")?,
        mime_type: row.get("mime_type")?,
        file_extension: row.get("file_extension")?,
        cached_original_path: row.get("cached_original_path")?,
        content_hash: row.get("content_hash")?,
        byte_size: row.get("byte_size")?,
        extraction_status: row.get("extraction_status")?,
        extraction_method: row.get("extraction_method")?,
        confidence: row.get("confidence")?,
        needs_review: needs_review_int != 0,
        created_at: row.get("created_at")?,
        imported_at: row.get("imported_at")?,
        schema_version: 1,
    })
}

// ────────────────────────────────────────────────────────────────────────────
// Commands
// ────────────────────────────────────────────────────────────────────────────

/// INSERT a new ImportJob row. Mirrors `ImportJobStore.insertJob(job)`.
/// Schema enforces the PK uniqueness; callers handle collisions by
/// regenerating the id (the TS side generates a fresh `vimp-<ts>-<rand>`
/// per run, so collisions don't happen in practice).
#[tauri::command]
pub fn vault_create_job(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    job: ImportJob,
) -> Result<(), String> {
    with_conn(&state, &app, |conn| {
        conn.execute(
            "INSERT INTO vault_import_jobs (
                id, status, source_provider, source_mode,
                file_count, processed_count, failed_count, warning_count,
                error_message, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                job.id,
                job.status,
                job.source_provider,
                job.source_mode,
                job.file_count,
                job.processed_count,
                job.failed_count,
                job.warning_count,
                job.error_message,
                job.created_at,
                job.updated_at,
            ],
        )
        .map(|_| ())
        .map_err(|e| format!("vault_create_job: {e}"))
    })
}

/// UPDATE an existing job's status. The TS port's signature allows an
/// optional errorMessage; we update it conditionally so a successful
/// `committed` transition doesn't clobber a prior error that the caller
/// might still want to surface in the UI.
///
/// `updated_at` is set to `now` (caller-supplied) so the renderer can
/// thread the same ISO clock that's used for the rest of the run.
#[tauri::command]
pub fn vault_update_job_status(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    job_id: String,
    status: String,
    error_message: Option<String>,
    now: String,
) -> Result<(), String> {
    with_conn(&state, &app, |conn| {
        if let Some(err) = &error_message {
            conn.execute(
                "UPDATE vault_import_jobs
                 SET status = ?1, error_message = ?2, updated_at = ?3
                 WHERE id = ?4",
                params![status, err, now, job_id],
            )
        } else {
            conn.execute(
                "UPDATE vault_import_jobs
                 SET status = ?1, updated_at = ?2
                 WHERE id = ?3",
                params![status, now, job_id],
            )
        }
        .map(|_| ())
        .map_err(|e| format!("vault_update_job_status: {e}"))
    })
}

/// Lookup a single job. Returns `None` rather than `Err` when the row
/// doesn't exist — that's a normal case for "did the previous session
/// leave anything pending?" boot probes.
#[tauri::command]
pub fn vault_get_job(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    job_id: String,
) -> Result<Option<ImportJob>, String> {
    with_conn(&state, &app, |conn| {
        conn.query_row(
            "SELECT id, status, source_provider, source_mode,
                    file_count, processed_count, failed_count, warning_count,
                    error_message, created_at, updated_at
             FROM vault_import_jobs WHERE id = ?1",
            params![job_id],
            row_to_job,
        )
        .optional()
        .map_err(|e| format!("vault_get_job: {e}"))
    })
}

/// Additive update for the four count columns. The TS port passes a
/// delta object with optional fields — fields that are `None` here
/// translate to a no-op for that column (we `COALESCE(?+col, col)` so
/// `NULL` deltas leave the column alone).
///
/// Single UPDATE so the four counters move atomically — the orchestrator
/// emits per-source events that increment `processed + failed` together,
/// and we don't want a half-applied state visible to concurrent readers.
#[tauri::command]
pub fn vault_increment_job_counts(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    job_id: String,
    delta: CountDelta,
    now: String,
) -> Result<(), String> {
    with_conn(&state, &app, |conn| {
        conn.execute(
            "UPDATE vault_import_jobs SET
               processed_count = processed_count + COALESCE(?1, 0),
               failed_count    = failed_count    + COALESCE(?2, 0),
               warning_count   = warning_count   + COALESCE(?3, 0),
               file_count      = file_count      + COALESCE(?4, 0),
               updated_at      = ?5
             WHERE id = ?6",
            params![
                delta.processed_count,
                delta.failed_count,
                delta.warning_count,
                delta.file_count,
                now,
                job_id,
            ],
        )
        .map(|_| ())
        .map_err(|e| format!("vault_increment_job_counts: {e}"))
    })
}

/// INSERT a SourceDocument row. The PK collision case is the dedupe
/// signal — the TS-side orchestrator already checks `KnownHashLookup`
/// against content_hash before calling, so a duplicate id here is a
/// real bug (would surface as the SQLite UNIQUE constraint error).
#[tauri::command]
pub fn vault_insert_source(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    doc: SourceDocument,
) -> Result<(), String> {
    with_conn(&state, &app, |conn| {
        conn.execute(
            "INSERT INTO vault_source_documents (
                id, import_job_id, source_type, source_provider, original_name,
                mime_type, file_extension, cached_original_path, content_hash,
                byte_size, extraction_status, extraction_method, confidence,
                needs_review, created_at, imported_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                doc.id,
                doc.import_job_id,
                doc.source_type,
                doc.source_provider,
                doc.original_name,
                doc.mime_type,
                doc.file_extension,
                doc.cached_original_path,
                doc.content_hash,
                doc.byte_size,
                doc.extraction_status,
                doc.extraction_method,
                doc.confidence,
                if doc.needs_review { 1i64 } else { 0i64 },
                doc.created_at,
                doc.imported_at,
            ],
        )
        .map(|_| ())
        .map_err(|e| format!("vault_insert_source: {e}"))
    })
}

/// All SourceDocuments for a given job, ordered by `created_at ASC` so
/// the renderer renders them in ingestion order (matches the order the
/// TS in-memory store currently returns).
#[tauri::command]
pub fn vault_list_sources_for_job(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    job_id: String,
) -> Result<Vec<SourceDocument>, String> {
    with_conn(&state, &app, |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT id, import_job_id, source_type, source_provider, original_name,
                        mime_type, file_extension, cached_original_path, content_hash,
                        byte_size, extraction_status, extraction_method, confidence,
                        needs_review, created_at, imported_at
                 FROM vault_source_documents
                 WHERE import_job_id = ?1
                 ORDER BY created_at ASC",
            )
            .map_err(|e| format!("vault_list_sources_for_job prepare: {e}"))?;
        let rows = stmt
            .query_map(params![job_id], row_to_source)
            .map_err(|e| format!("vault_list_sources_for_job query: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("vault_list_sources_for_job row: {e}"))?);
        }
        Ok(out)
    })
}

// ────────────────────────────────────────────────────────────────────────────
// Resumable-imports surface: ProjectMatch / ExtractedItem / NoteDraft IPC.
// Added by the resumable-vault-imports arc on top of slice 1's job +
// source store. These rows are written at the end of `runner.run()` so
// boot hydration can rebuild the full review state across reloads.
// ────────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMatch {
    pub id: String,
    pub source_document_id: String,
    /// Foreign key into ventures.id; null when the match resolves to
    /// "unsorted" (the project-classifier's default for low-confidence).
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_project_name: Option<String>,
    /// "high" | "medium" | "low" — the Confidence enum from
    /// @founder-os/vault-contract. Stored as a string column.
    pub confidence: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedItem {
    pub id: String,
    pub source_document_id: String,
    pub project_id: Option<String>,
    /// ExtractedItemType enum: decision / task / idea / prompt / summary /
    /// brand_reference / ui_reference / research_finding / code_snippet /
    /// todo / question / fact. Stored as string.
    pub r#type: String,
    pub title: String,
    pub content: String,
    pub confidence: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Matches the @founder-os/vault-runner VaultNoteDraft TS type plus the
/// vault_note_drafts row layout. Variables / item_ids / tags ride through
/// as JSON strings -- the renderer deserialises them after read.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDraft {
    /// Maps to draft.noteId on the TS side.
    pub id: String,
    pub import_job_id: String,
    pub source_document_id: String,
    pub note_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_venture_slug: Option<String>,
    pub title: String,
    pub preview_content: String,
    /// JSON-encoded VaultNoteFrontmatter.
    pub preview_frontmatter_json: String,
    /// JSON array of item ids.
    pub item_ids_json: String,
    /// JSON array of tag strings.
    pub tags_json: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<String>,
    /// JSON object the runner built for handlebars template rendering.
    pub variables_json: String,
    pub created_at: String,
    /// VAULT_TEMPLATE_VERSION at the moment this draft was persisted.
    /// Boot hydration compares against the runtime constant; mismatch
    /// forces a re-render even when the slug matches. Defaults to 1
    /// for old rows -- see migration 0014's notes.
    #[serde(default = "default_template_version")]
    pub template_version: u32,
}

fn default_template_version() -> u32 {
    1
}

fn row_to_match(row: &Row<'_>) -> rusqlite::Result<ProjectMatch> {
    Ok(ProjectMatch {
        id: row.get("id")?,
        source_document_id: row.get("source_document_id")?,
        project_id: row.get("project_id")?,
        suggested_project_name: row.get("suggested_project_name")?,
        confidence: row.get("confidence")?,
        reason: row.get("reason")?,
        status: row.get("status")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_item(row: &Row<'_>) -> rusqlite::Result<ExtractedItem> {
    Ok(ExtractedItem {
        id: row.get("id")?,
        source_document_id: row.get("source_document_id")?,
        project_id: row.get("project_id")?,
        r#type: row.get("type")?,
        title: row.get("title")?,
        content: row.get("content")?,
        confidence: row.get("confidence")?,
        status: row.get("status")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_draft(row: &Row<'_>) -> rusqlite::Result<NoteDraft> {
    Ok(NoteDraft {
        id: row.get("id")?,
        import_job_id: row.get("import_job_id")?,
        source_document_id: row.get("source_document_id")?,
        note_type: row.get("note_type")?,
        suggested_venture_slug: row.get("suggested_venture_slug")?,
        title: row.get("title")?,
        preview_content: row.get("preview_content")?,
        preview_frontmatter_json: row.get("preview_frontmatter_json")?,
        item_ids_json: row.get("item_ids_json")?,
        tags_json: row.get("tags_json")?,
        confidence: row.get("confidence")?,
        variables_json: row.get("variables_json")?,
        created_at: row.get("created_at")?,
        template_version: {
            // i64 from SQLite -> u32; clamp negatives + overflow.
            let raw: i64 = row.get("template_version")?;
            if raw < 0 { 1 } else { raw as u32 }
        },
    })
}

#[tauri::command]
pub fn vault_insert_project_match(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    row: ProjectMatch,
) -> Result<(), String> {
    with_conn(&state, &app, |conn| {
        conn.execute(
            "INSERT OR REPLACE INTO vault_project_matches (
                id, source_document_id, project_id, suggested_project_name,
                confidence, reason, status, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                row.id,
                row.source_document_id,
                row.project_id,
                row.suggested_project_name,
                row.confidence,
                row.reason,
                row.status,
                row.created_at,
                row.updated_at,
            ],
        )
        .map(|_| ())
        .map_err(|e| format!("vault_insert_project_match: {e}"))
    })
}

#[tauri::command]
pub fn vault_list_project_matches_for_job(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    job_id: String,
) -> Result<Vec<ProjectMatch>, String> {
    with_conn(&state, &app, |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT m.id, m.source_document_id, m.project_id, m.suggested_project_name,
                        m.confidence, m.reason, m.status, m.created_at, m.updated_at
                 FROM vault_project_matches m
                 JOIN vault_source_documents s ON s.id = m.source_document_id
                 WHERE s.import_job_id = ?1
                 ORDER BY m.created_at ASC",
            )
            .map_err(|e| format!("vault_list_project_matches_for_job prepare: {e}"))?;
        let rows = stmt
            .query_map(params![job_id], row_to_match)
            .map_err(|e| format!("vault_list_project_matches_for_job query: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("vault_list_project_matches_for_job row: {e}"))?);
        }
        Ok(out)
    })
}

#[tauri::command]
pub fn vault_insert_extracted_item(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    row: ExtractedItem,
) -> Result<(), String> {
    with_conn(&state, &app, |conn| {
        conn.execute(
            "INSERT OR REPLACE INTO vault_extracted_items (
                id, source_document_id, project_id, type, title, content,
                confidence, status, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                row.id,
                row.source_document_id,
                row.project_id,
                row.r#type,
                row.title,
                row.content,
                row.confidence,
                row.status,
                row.created_at,
                row.updated_at,
            ],
        )
        .map(|_| ())
        .map_err(|e| format!("vault_insert_extracted_item: {e}"))
    })
}

#[tauri::command]
pub fn vault_list_extracted_items_for_job(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    job_id: String,
) -> Result<Vec<ExtractedItem>, String> {
    with_conn(&state, &app, |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT i.id, i.source_document_id, i.project_id, i.type, i.title, i.content,
                        i.confidence, i.status, i.created_at, i.updated_at
                 FROM vault_extracted_items i
                 JOIN vault_source_documents s ON s.id = i.source_document_id
                 WHERE s.import_job_id = ?1
                 ORDER BY i.created_at ASC",
            )
            .map_err(|e| format!("vault_list_extracted_items_for_job prepare: {e}"))?;
        let rows = stmt
            .query_map(params![job_id], row_to_item)
            .map_err(|e| format!("vault_list_extracted_items_for_job query: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("vault_list_extracted_items_for_job row: {e}"))?);
        }
        Ok(out)
    })
}

#[tauri::command]
pub fn vault_insert_note_draft(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    row: NoteDraft,
) -> Result<(), String> {
    with_conn(&state, &app, |conn| {
        conn.execute(
            "INSERT OR REPLACE INTO vault_note_drafts (
                id, import_job_id, source_document_id, note_type,
                suggested_venture_slug, title, preview_content,
                preview_frontmatter_json, item_ids_json, tags_json,
                confidence, variables_json, created_at, template_version
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                row.id,
                row.import_job_id,
                row.source_document_id,
                row.note_type,
                row.suggested_venture_slug,
                row.title,
                row.preview_content,
                row.preview_frontmatter_json,
                row.item_ids_json,
                row.tags_json,
                row.confidence,
                row.variables_json,
                row.created_at,
                row.template_version as i64,
            ],
        )
        .map(|_| ())
        .map_err(|e| format!("vault_insert_note_draft: {e}"))
    })
}

#[tauri::command]
pub fn vault_list_note_drafts_for_job(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    job_id: String,
) -> Result<Vec<NoteDraft>, String> {
    with_conn(&state, &app, |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT id, import_job_id, source_document_id, note_type,
                        suggested_venture_slug, title, preview_content,
                        preview_frontmatter_json, item_ids_json, tags_json,
                        confidence, variables_json, created_at, template_version
                 FROM vault_note_drafts
                 WHERE import_job_id = ?1
                 ORDER BY created_at ASC",
            )
            .map_err(|e| format!("vault_list_note_drafts_for_job prepare: {e}"))?;
        let rows = stmt
            .query_map(params![job_id], row_to_draft)
            .map_err(|e| format!("vault_list_note_drafts_for_job query: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("vault_list_note_drafts_for_job row: {e}"))?);
        }
        Ok(out)
    })
}

// ────────────────────────────────────────────────────────────────────────────
// Lifecycle (continued)
// ────────────────────────────────────────────────────────────────────────────

/// Drop the transient support rows (drafts / matches / items) for a
/// **committed** job. Used after a successful finalize: the markdown is
/// safely on disk + the SQLite `vault_notes` row + `vault_import_jobs`
/// row are sufficient to render the committed surface in the browser.
/// Holding onto matches / items / drafts forever bloats founder.db for
/// no benefit -- they were a recoverability buffer for the
/// review-in-progress state, and the review is over.
///
/// SAFETY: refuses unless `vault_import_jobs.status = 'committed'`. A
/// missing job, or a job in any other status, is a no-op success. This
/// guard means an over-eager caller can't accidentally wipe state mid-
/// review just because they got the wrong jobId.
///
/// What this does NOT touch:
///   - vault_import_jobs           (the job stays as `committed`)
///   - vault_source_documents      (the sources are the historical record)
///   - vault_notes                 (the committed note index)
///   - vault_source_extractions / vault_source_images / vault_import_sources
///     (historical extraction metadata stays around for diagnostics)
///
/// Returns the number of rows dropped across the three tables for
/// observability + the renderer's success toast.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupCommittedSupportResult {
    pub job_id: String,
    pub drafts_dropped: u64,
    pub matches_dropped: u64,
    pub items_dropped: u64,
}

#[tauri::command]
pub fn vault_cleanup_committed_job_support(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    job_id: String,
) -> Result<CleanupCommittedSupportResult, String> {
    with_conn(&state, &app, |conn| {
        // Status guard. `query_row` returns Err on no row; we map that
        // to the "missing job is a no-op" branch rather than surfacing
        // it as an error -- this command runs after a successful commit
        // so racing with a delete elsewhere shouldn't fail the caller.
        let status: Option<String> = conn
            .query_row(
                "SELECT status FROM vault_import_jobs WHERE id = ?1",
                params![job_id],
                |row| row.get(0),
            )
            .ok();
        let Some(status) = status else {
            return Ok(CleanupCommittedSupportResult {
                job_id,
                drafts_dropped: 0,
                matches_dropped: 0,
                items_dropped: 0,
            });
        };
        if status != "committed" {
            return Err(format!(
                "vault_cleanup_committed_job_support: job {job_id} is in status \
                 '{status}', not 'committed'; refusing to drop support rows. \
                 If you want to discard a needs_review job, use vault_discard_job."
            ));
        }

        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("cleanup begin: {e}"))?;
        let drafts_dropped = tx
            .execute(
                "DELETE FROM vault_note_drafts WHERE import_job_id = ?1",
                params![job_id],
            )
            .map_err(|e| format!("cleanup drafts: {e}"))? as u64;
        let matches_dropped = tx
            .execute(
                "DELETE FROM vault_project_matches WHERE source_document_id IN \
                 (SELECT id FROM vault_source_documents WHERE import_job_id = ?1)",
                params![job_id],
            )
            .map_err(|e| format!("cleanup matches: {e}"))? as u64;
        let items_dropped = tx
            .execute(
                "DELETE FROM vault_extracted_items WHERE source_document_id IN \
                 (SELECT id FROM vault_source_documents WHERE import_job_id = ?1)",
                params![job_id],
            )
            .map_err(|e| format!("cleanup items: {e}"))? as u64;
        tx.commit()
            .map_err(|e| format!("cleanup commit: {e}"))?;
        Ok(CleanupCommittedSupportResult {
            job_id,
            drafts_dropped,
            matches_dropped,
            items_dropped,
        })
    })
}

/// Drop a job + its source rows. Used by the slice-4 recovery panel
/// when the user can't resume a previous-session review (the runner
/// state — drafts, matches, items — is in-memory only and doesn't
/// survive reloads). The transaction deletes sources first then the
/// job to satisfy the foreign key. We accept the row not existing as
/// a no-op success — discarding a stale id is idempotent.
#[tauri::command]
pub fn vault_discard_job(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    job_id: String,
) -> Result<(), String> {
    with_conn(&state, &app, |conn| {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("vault_discard_job begin: {e}"))?;
        // Cascade FK-safely: every table that references a source row
        // OR the job row, then the source rows, then the job row.
        // Migration 0012 + 0013 created the following children:
        //   vault_note_drafts          -> sources + jobs (resumable arc)
        //   vault_project_matches      -> sources
        //   vault_extracted_items      -> sources
        //   vault_source_extractions   -> sources
        //   vault_source_images        -> sources
        //   vault_import_sources       -> jobs
        // After all of those, vault_source_documents (parent of source
        // refs) then vault_import_jobs (root).
        for sql in [
            "DELETE FROM vault_note_drafts WHERE import_job_id = ?1",
            "DELETE FROM vault_project_matches WHERE source_document_id IN \
             (SELECT id FROM vault_source_documents WHERE import_job_id = ?1)",
            "DELETE FROM vault_extracted_items WHERE source_document_id IN \
             (SELECT id FROM vault_source_documents WHERE import_job_id = ?1)",
            "DELETE FROM vault_source_extractions WHERE source_document_id IN \
             (SELECT id FROM vault_source_documents WHERE import_job_id = ?1)",
            "DELETE FROM vault_source_images WHERE source_document_id IN \
             (SELECT id FROM vault_source_documents WHERE import_job_id = ?1)",
            "DELETE FROM vault_import_sources WHERE import_job_id = ?1",
            "DELETE FROM vault_source_documents WHERE import_job_id = ?1",
            "DELETE FROM vault_import_jobs WHERE id = ?1",
        ] {
            tx.execute(sql, params![job_id])
                .map_err(|e| format!("vault_discard_job ({sql}): {e}"))?;
        }
        tx.commit()
            .map_err(|e| format!("vault_discard_job commit: {e}"))?;
        Ok(())
    })
}

/// List jobs newest-first. Used by slice-4's boot hydration which only
/// cares about `status = 'needs_review'` — but exposing the filter as
/// optional keeps the command flexible for a future "import history"
/// surface without a second command.
///
/// Limit defaults to 50; the renderer doesn't need a paginated history
/// yet and the pending-imports panel only ever shows the most recent
/// handful.
#[tauri::command]
pub fn vault_list_jobs(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    status: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<ImportJob>, String> {
    let limit = limit.unwrap_or(50).clamp(1, 500);
    with_conn(&state, &app, |conn| {
        let sql_with_filter = "SELECT id, status, source_provider, source_mode,
                file_count, processed_count, failed_count, warning_count,
                error_message, created_at, updated_at
         FROM vault_import_jobs
         WHERE status = ?1
         ORDER BY created_at DESC
         LIMIT ?2";
        let sql_no_filter = "SELECT id, status, source_provider, source_mode,
                file_count, processed_count, failed_count, warning_count,
                error_message, created_at, updated_at
         FROM vault_import_jobs
         ORDER BY created_at DESC
         LIMIT ?1";
        let mut out = Vec::new();
        if let Some(s) = status {
            let mut stmt = conn
                .prepare(sql_with_filter)
                .map_err(|e| format!("vault_list_jobs prepare: {e}"))?;
            let rows = stmt
                .query_map(params![s, limit], row_to_job)
                .map_err(|e| format!("vault_list_jobs query: {e}"))?;
            for r in rows {
                out.push(r.map_err(|e| format!("vault_list_jobs row: {e}"))?);
            }
        } else {
            let mut stmt = conn
                .prepare(sql_no_filter)
                .map_err(|e| format!("vault_list_jobs prepare: {e}"))?;
            let rows = stmt
                .query_map(params![limit], row_to_job)
                .map_err(|e| format!("vault_list_jobs query: {e}"))?;
            for r in rows {
                out.push(r.map_err(|e| format!("vault_list_jobs row: {e}"))?);
            }
        }
        Ok(out)
    })
}
