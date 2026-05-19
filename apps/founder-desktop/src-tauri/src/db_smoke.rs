//! Schema drift smoke test — verifies that every table the app
//! expects to exist actually got created by some migration.
//!
//! Why this module exists
//! ----------------------
//! The DREAM_VAULT arc filed its slice-1 migration in
//! `packages/db/src/migrations/0002-vault.sql` — the npm-package
//! directory — instead of `apps/founder-desktop/src-tauri/migrations/`
//! which is what the Tauri app's `include_str!` macros actually load.
//! Result: `0002-vault.sql` was a dead file, the vault tables didn't
//! exist on disk, and nobody noticed because every renderer code path
//! was wrapped in `safeInvoke` that swallowed the resulting errors.
//! The bug only surfaced when the Rust IPC arc tried to write to
//! `vault_import_jobs` and hit "no such table".
//!
//! This module is the cheap insurance against that class of bug. After
//! migrations apply, we probe `sqlite_master` for every table in
//! `REQUIRED_TABLES`. If anything is missing, we print a loud error to
//! stderr (visible in `tauri dev` and in production logs) and emit a
//! Tauri event the renderer surfaces as a toast.
//!
//! Adding a table
//! --------------
//! 1. Land the migration in `apps/founder-desktop/src-tauri/migrations/`.
//! 2. Register the file in `lib.rs::migrations()`.
//! 3. Add the table name to `REQUIRED_TABLES` below.
//!
//! Forgetting step 1 was the original bug. Step 3 is the smoke-test
//! catch — if the migration didn't actually run, the table is missing
//! and the smoke test fails loudly. The list serves as a manifest;
//! review it whenever a migration lands.

use std::path::PathBuf;

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{Emitter, Manager};

/// Every table any module in this crate expects to read or write.
/// Order doesn't matter; we check membership only. New tables get
/// appended here when their migrations land.
///
/// Grouped by migration source for grep-ability:
///   0001-init                  : ventures, artifacts, runs, audit_findings, tasks
///   0002-llm-settings          : llm_settings, app_settings
///   0004-audit-fix-suggestions : audit_fix_suggestions
///   0007/0008/0009/0010        : pm_cache, pm_events, pm_event_ventures, pm_event_models
///   0011-brand-name-candidates : brand_name_candidates
///   0012-vault (Rust IPC arc)  : vault_* (9 tables)
const REQUIRED_TABLES: &[&str] = &[
    // 0001-init
    "ventures",
    "artifacts",
    "runs",
    "audit_findings",
    "chat_messages",
    "tasks",
    // 0002-llm-settings
    "llm_settings",
    "app_settings",
    // 0004-audit-fix-suggestions
    "audit_fix_suggestions",
    // 0007-prompt-master-cache + 0008 downstream
    "prompt_master_cache",
    "prompt_master_events",
    // 0011-brand-name-candidates
    "brand_name_candidates",
    // 0012-vault
    "vault_import_jobs",
    "vault_source_documents",
    "vault_source_extractions",
    "vault_source_images",
    "vault_project_matches",
    "vault_extracted_items",
    "vault_notes",
    "vault_cloud_connections",
    "vault_import_sources",
    // 0013-vault-drafts (resumable imports arc)
    "vault_note_drafts",
];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SchemaSmokeReport {
    pub ok: bool,
    /// Names of tables that should exist but don't. Empty on success.
    pub missing: Vec<String>,
    /// Total tables probed.
    pub total: usize,
    /// Path to the SQLite file we probed.
    pub db_path: String,
}

/// Resolve the founder.db path the same way the migration plugin does.
fn resolve_db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolve app_config_dir: {e}"))?;
    Ok(dir.join("founder.db"))
}

/// Run the smoke test. Returns the report regardless of pass/fail so
/// the caller can decide how loudly to surface it.
fn probe(conn: &Connection) -> Vec<String> {
    let mut missing = Vec::new();
    for table in REQUIRED_TABLES {
        let exists: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
                params![table],
                |row| row.get(0),
            )
            .ok();
        if exists.is_none() {
            missing.push((*table).to_string());
        }
    }
    missing
}

/// Boot-time entry point. Runs the probe; if any tables are missing,
/// prints a loud stderr banner and emits the `db:schema-smoke` event
/// for the renderer to toast.
///
/// Never panics, never blocks the app — this is a diagnostic, not a
/// gate. A failed smoke test means commands will fail later; better
/// to surface that now than to debug it from a vague "no such table"
/// error half an hour later.
pub fn run_on_boot(app: &tauri::AppHandle) {
    let db_path = match resolve_db_path(app) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[db_smoke] could not resolve db path: {e}");
            return;
        }
    };
    let conn = match Connection::open(&db_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[db_smoke] open '{}' failed: {e}", db_path.display());
            return;
        }
    };
    let missing = probe(&conn);
    let report = SchemaSmokeReport {
        ok: missing.is_empty(),
        missing: missing.clone(),
        total: REQUIRED_TABLES.len(),
        db_path: db_path.to_string_lossy().to_string(),
    };
    if !missing.is_empty() {
        eprintln!(
            "[db_smoke] ============================================================"
        );
        eprintln!(
            "[db_smoke] SCHEMA DRIFT DETECTED: {} of {} required tables missing!",
            missing.len(),
            REQUIRED_TABLES.len()
        );
        eprintln!("[db_smoke] db: {}", db_path.display());
        eprintln!("[db_smoke] missing tables: {}", missing.join(", "));
        eprintln!("[db_smoke] usual cause: a migration .sql file lives in the wrong");
        eprintln!("[db_smoke] directory (npm packages/db/src/migrations/ vs Tauri");
        eprintln!("[db_smoke] apps/founder-desktop/src-tauri/migrations/) — the");
        eprintln!("[db_smoke] include_str! macros in lib.rs only see the latter.");
        eprintln!(
            "[db_smoke] ============================================================"
        );
    } else {
        // Single line on success so it doesn't drown out other boot logs.
        eprintln!(
            "[db_smoke] schema OK: {}/{} tables present",
            REQUIRED_TABLES.len(),
            REQUIRED_TABLES.len()
        );
    }
    // Always emit so the renderer can surface either state. The
    // success case is silent renderer-side; the failure case lets
    // the renderer toast a user-visible warning.
    if let Err(e) = app.emit("db:schema-smoke", &report) {
        eprintln!("[db_smoke] failed to emit db:schema-smoke event: {e}");
    }
}

/// Tauri command exposed for the renderer to re-run the probe on
/// demand (e.g., a "Verify schema" button in a future diagnostics UI).
/// Doesn't emit — the caller awaits the return value.
#[tauri::command]
pub fn db_run_schema_smoke(app: tauri::AppHandle) -> Result<SchemaSmokeReport, String> {
    let db_path = resolve_db_path(&app)?;
    let conn = Connection::open(&db_path)
        .map_err(|e| format!("open '{}' failed: {e}", db_path.display()))?;
    let missing = probe(&conn);
    Ok(SchemaSmokeReport {
        ok: missing.is_empty(),
        missing,
        total: REQUIRED_TABLES.len(),
        db_path: db_path.to_string_lossy().to_string(),
    })
}
