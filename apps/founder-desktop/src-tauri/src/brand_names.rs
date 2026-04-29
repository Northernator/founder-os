//! Persistent triage list for generated brand-name candidates.
//!
//! The Brand tab generates name candidates in batches and previously
//! held them only in the per-venture `name-candidates.json` blob. This
//! module backs a separate SQLite table that stores every name we've
//! ever generated for a venture plus a triage status (`new`, `possible`,
//! `fail`) so the user can pick over multiple regeneration runs without
//! losing context on already-rejected names.
//!
//! Three commands:
//!
//!   brand_name_upsert(venture_id, name, info_json) -> ()
//!     INSERT OR IGNORE — first sighting becomes status='new', repeats
//!     are no-ops so a regen never stomps a decided status. If you
//!     later want a "refresh research on this name" affordance, add it
//!     as an explicit command rather than mutating this one.
//!
//!   brand_name_set_status(venture_id, name, status) -> ()
//!     UPDATE the row's status + decided_at. Status must be one of
//!     'new' | 'possible' | 'fail'; anything else is rejected.
//!     Setting back to 'new' clears decided_at so the row sorts
//!     by created_at again.
//!
//!   brand_name_list(venture_id) -> Vec<BrandNameRow>
//!     Returns every row for the venture in one shot. Ordering is
//!     possible (by decided_at DESC) → new (by created_at DESC) → fail
//!     (by decided_at DESC) so the UI can render a single grouped list
//!     without re-sorting.
//!
//! Schema lives in `migrations/0011-brand-name-candidates.sql`. The
//! connection is opened lazily on the first command via the same
//! pattern as `cache.rs` — Tauri's `app_config_dir` isn't resolvable
//! until setup finishes, so we can't open the DB at registration time.

use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State};

/// Allowed status transitions for a candidate. Kept as a tiny constant
/// list so adding a state means updating one place plus the migration's
/// CHECK-style logic in `brand_name_set_status`.
const VALID_STATUSES: &[&str] = &["new", "possible", "fail"];

#[derive(Default)]
pub struct BrandNamesState {
    /// Lazily-initialised connection. Mirrors `CacheState::conn` —
    /// `None` until the first command runs because `app_config_dir`
    /// isn't resolvable at registration time.
    conn: Mutex<Option<Connection>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandNameRow {
    pub name: String,
    /// Raw JSON payload as written by the TS caller. Forwarded as a
    /// string so the renderer can `JSON.parse` and inspect whichever
    /// fields it needs without us re-deriving a schema in Rust.
    pub info_json: String,
    pub status: String,
    pub created_at: String,
    /// `None` while the row is still in 'new'. Only set when a triage
    /// decision moves the row out of new (and cleared if it's moved
    /// back).
    pub decided_at: Option<String>,
}

/// Resolve the founder.db path the same way `tauri-plugin-sql` does so
/// both connections point at the same physical file.
fn resolve_db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolve app_config_dir: {e}"))?;
    Ok(dir.join("founder.db"))
}

/// Acquire the lazy connection and run `f` against it. WAL is set on
/// first open so reads don't block writes; subsequent calls just lock
/// and run.
fn with_conn<R, F>(
    state: &State<'_, BrandNamesState>,
    app: &tauri::AppHandle,
    f: F,
) -> Result<R, String>
where
    F: FnOnce(&Connection) -> Result<R, String>,
{
    let mut guard = state
        .conn
        .lock()
        .map_err(|_| "brand_names mutex poisoned".to_string())?;
    if guard.is_none() {
        let path = resolve_db_path(app)?;
        let conn = Connection::open(&path)
            .map_err(|e| format!("open brand_names db at {}: {}", path.display(), e))?;
        // WAL is sticky on disk — calling it on every open after the
        // first is harmless, and keeps the brand_names traffic from
        // contending with the prompt-master cache writes.
        let _: String = conn
            .query_row("PRAGMA journal_mode=WAL;", [], |r| r.get(0))
            .map_err(|e| format!("set WAL: {e}"))?;
        *guard = Some(conn);
    }
    let conn = guard.as_ref().expect("connection just initialised");
    f(conn)
}

/// Insert a candidate as status='new' on first sighting. Repeats of the
/// same (venture_id, name) are no-ops by design — regenerating a known
/// name must not stomp a triage decision the user has already made.
#[tauri::command]
pub fn brand_name_upsert(
    app: tauri::AppHandle,
    state: State<'_, BrandNamesState>,
    venture_id: String,
    name: String,
    info_json: String,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("name cannot be empty".to_string());
    }
    with_conn(&state, &app, |conn| {
        let now = current_iso();
        conn.execute(
            "INSERT OR IGNORE INTO brand_name_candidates \
             (venture_id, name, info_json, status, created_at) \
             VALUES (?1, ?2, ?3, 'new', ?4)",
            params![venture_id, name, info_json, now],
        )
        .map_err(|e| format!("brand_name upsert: {e}"))?;
        Ok(())
    })
}

/// Replace the stored `info_json` payload for an existing row without
/// touching the triage status or decided_at. Used after running domain
/// / trademark / social availability checks — those mutate fields
/// inside the info payload but the founder's triage decision is
/// independent of the research.
///
/// Errors when the row doesn't exist; the caller should `brand_name_upsert`
/// first if it might be a fresh name. Doing it that way (rather than an
/// upsert-with-merge) keeps the two operations distinct: insertion is
/// the place that picks the initial 'new' status, updates strictly
/// rewrite info.
#[tauri::command]
pub fn brand_name_update_info(
    app: tauri::AppHandle,
    state: State<'_, BrandNamesState>,
    venture_id: String,
    name: String,
    info_json: String,
) -> Result<(), String> {
    with_conn(&state, &app, |conn| {
        let updated = conn
            .execute(
                "UPDATE brand_name_candidates \
                 SET info_json = ?1 \
                 WHERE venture_id = ?2 AND name = ?3",
                params![info_json, venture_id, name],
            )
            .map_err(|e| format!("brand_name update_info: {e}"))?;
        if updated == 0 {
            return Err(format!(
                "no candidate '{}' found for venture {}",
                name, venture_id
            ));
        }
        Ok(())
    })
}

/// Move a candidate to a new triage status. Sets `decided_at` to now
/// for terminal states; clearing back to 'new' wipes `decided_at` so
/// the row re-enters the new section ordered by its original
/// `created_at`.
#[tauri::command]
pub fn brand_name_set_status(
    app: tauri::AppHandle,
    state: State<'_, BrandNamesState>,
    venture_id: String,
    name: String,
    status: String,
) -> Result<(), String> {
    if !VALID_STATUSES.contains(&status.as_str()) {
        return Err(format!(
            "invalid status '{}' (expected one of: {})",
            status,
            VALID_STATUSES.join(", ")
        ));
    }
    with_conn(&state, &app, |conn| {
        let updated = if status == "new" {
            conn.execute(
                "UPDATE brand_name_candidates \
                 SET status = ?1, decided_at = NULL \
                 WHERE venture_id = ?2 AND name = ?3",
                params![status, venture_id, name],
            )
            .map_err(|e| format!("brand_name set_status: {e}"))?
        } else {
            let now = current_iso();
            conn.execute(
                "UPDATE brand_name_candidates \
                 SET status = ?1, decided_at = ?2 \
                 WHERE venture_id = ?3 AND name = ?4",
                params![status, now, venture_id, name],
            )
            .map_err(|e| format!("brand_name set_status: {e}"))?
        };
        if updated == 0 {
            return Err(format!(
                "no candidate '{}' found for venture {}",
                name, venture_id
            ));
        }
        Ok(())
    })
}

/// Return every candidate for a venture, ordered by section then by
/// most-recent activity. The UI can iterate in returned order to render
/// POSSIBLE → NEW → FAIL without re-sorting client-side.
#[tauri::command]
pub fn brand_name_list(
    app: tauri::AppHandle,
    state: State<'_, BrandNamesState>,
    venture_id: String,
) -> Result<Vec<BrandNameRow>, String> {
    with_conn(&state, &app, |conn| {
        // CASE numbers the sections; the secondary ORDER BY uses the
        // appropriate timestamp per section. COALESCE on decided_at
        // protects the ORDER BY from NULL collation surprises (in
        // SQLite NULLs sort first by default; we want them out of the
        // way for fail/possible).
        let mut stmt = conn
            .prepare(
                "SELECT name, info_json, status, created_at, decided_at \
                 FROM brand_name_candidates \
                 WHERE venture_id = ?1 \
                 ORDER BY \
                   CASE status \
                     WHEN 'possible' THEN 0 \
                     WHEN 'new'      THEN 1 \
                     WHEN 'fail'     THEN 2 \
                     ELSE 3 \
                   END ASC, \
                   COALESCE(decided_at, created_at) DESC, \
                   id DESC",
            )
            .map_err(|e| format!("brand_name list prepare: {e}"))?;

        let rows = stmt
            .query_map(params![venture_id], |r| {
                Ok(BrandNameRow {
                    name: r.get(0)?,
                    info_json: r.get(1)?,
                    status: r.get(2)?,
                    created_at: r.get(3)?,
                    decided_at: r.get::<_, Option<String>>(4)?,
                })
            })
            .map_err(|e| format!("brand_name list query: {e}"))?;

        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| format!("brand_name list row: {e}"))?);
        }
        Ok(out)
    })
}

/// ISO-8601 UTC clock. Mirrors `cache.rs::current_iso` exactly so
/// timestamps written across the two tables sort as strings without
/// surprises. Duplicated rather than promoted to a crate-wide helper
/// because making it `pub(crate)` would widen its visibility further
/// than either module strictly needs.
fn current_iso() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;

    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let hour = sod / 3600;
    let minute = (sod / 60) % 60;
    let second = sod % 60;

    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hour, minute, second
    )
}
