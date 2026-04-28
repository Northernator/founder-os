/*!
 * handoff_watcher - Phase 2.3
 *
 * Watches `<ventureRoot>/.founder/handoffs/outbox/` and `.../progress/` for
 * new JSON files written by the VS Code extension and emits Tauri events
 * to the frontend so the HandoffStore can refresh in real time.
 *
 * Design notes:
 *   - One `RecommendedWatcher` per venture root, kept in a process-wide
 *     `WatcherRegistry` so the frontend can start/stop watchers when the
 *     active venture changes.
 *   - We only do the *minimum* parsing on the Rust side: read the file as a
 *     string and attach it to the event. Full Zod validation lives in the
 *     handoff-contract TS package; duplicating it here would be a drift
 *     hazard.
 *   - Events emitted:
 *       "handoff:result"   -> { runId, ventureRoot, body }   (from outbox JSON files)
 *       "handoff:progress" -> { runId, ventureRoot, body }   (from progress JSON files)
 *     where `body` is the raw JSON text. The frontend parses + validates.
 *     (Don't write `outbox/<star>.json` or `progress/<star>.json` here —
 *     Rust block comments nest, so the `/<star>` sequence opens a nested
 *     comment that never closes and the rest of the file is swallowed.
 *     Bit us once already; same family as the `**<slash>` JSDoc gotcha
 *     in markdown.ts. Use words, not glob syntax, in block comments.)
 *   - File reads happen on the watcher thread. `notify` debounces nothing —
 *     editors and atomic-rename writers may fire multiple events for one
 *     write. We rely on the frontend to dedupe by runId; here we just skip
 *     reads that hit ENOENT (vanished mid-event).
 */

use notify::{
    Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
    event::CreateKind, event::ModifyKind, event::DataChange,
};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct WatcherRegistry {
    /// Keyed on `venture_root`. Dropping a watcher stops it, so we keep
    /// owned handles here for explicit start/stop.
    inner: Mutex<HashMap<String, RecommendedWatcher>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HandoffEvent {
    run_id: String,
    venture_root: String,
    /// Raw JSON text from the file. The frontend runs Zod parsing.
    body: String,
}

/// Start watching outbox/ + progress/ for the given venture root. Idempotent:
/// calling twice with the same root replaces the previous watcher.
#[tauri::command]
pub fn start_handoff_watcher(
    venture_root: String,
    app: AppHandle,
    registry: State<WatcherRegistry>,
) -> Result<(), String> {
    let outbox = handoff_subdir(&venture_root, "outbox");
    let progress = handoff_subdir(&venture_root, "progress");

    // Make sure the dirs exist - notify::watch fails on a missing path.
    std::fs::create_dir_all(&outbox)
        .map_err(|e| format!("mkdir outbox failed: {}", e))?;
    std::fs::create_dir_all(&progress)
        .map_err(|e| format!("mkdir progress failed: {}", e))?;

    let app_handle = app.clone();
    let venture_root_clone = venture_root.clone();
    let outbox_path = outbox.clone();
    let progress_path = progress.clone();

    let mut watcher: RecommendedWatcher = notify::recommended_watcher(
        move |res: Result<Event, notify::Error>| {
            let event = match res {
                Ok(e) => e,
                Err(err) => {
                    let _ = app_handle.emit(
                        "handoff:watcher-error",
                        format!("notify error: {}", err),
                    );
                    return;
                }
            };
            handle_event(&event, &outbox_path, &progress_path, &venture_root_clone, &app_handle);
        },
    )
    .map_err(|e| format!("create watcher failed: {}", e))?;

    watcher
        .watch(&outbox, RecursiveMode::NonRecursive)
        .map_err(|e| format!("watch outbox failed: {}", e))?;
    watcher
        .watch(&progress, RecursiveMode::NonRecursive)
        .map_err(|e| format!("watch progress failed: {}", e))?;

    // Replace any previous watcher for this venture root.
    let mut guard = registry.inner.lock().map_err(|e| e.to_string())?;
    guard.insert(venture_root.clone(), watcher);

    // Backfill: emit events for files that already exist when the watcher
    // starts (parallels chokidar's `ignoreInitial: false` on the extension
    // side). Useful when the desktop launches after the extension already
    // wrote results.
    backfill(&outbox, "handoff:result", &venture_root, &app);
    backfill(&progress, "handoff:progress", &venture_root, &app);

    Ok(())
}

#[tauri::command]
pub fn stop_handoff_watcher(
    venture_root: String,
    registry: State<WatcherRegistry>,
) -> Result<(), String> {
    let mut guard = registry.inner.lock().map_err(|e| e.to_string())?;
    guard.remove(&venture_root);
    Ok(())
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

fn handoff_subdir(venture_root: &str, sub: &str) -> PathBuf {
    let mut p = PathBuf::from(venture_root);
    p.push(".founder");
    p.push("handoffs");
    p.push(sub);
    p
}

/// Decide whether a notify event represents a "file is now ready to read"
/// transition. We accept Create(File) and Modify(Data(Any)) - editors that
/// use atomic rename fire Modify, fresh writes fire Create.
fn is_settled_event(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(CreateKind::File)
            | EventKind::Create(CreateKind::Any)
            | EventKind::Modify(ModifyKind::Data(DataChange::Any))
            | EventKind::Modify(ModifyKind::Data(DataChange::Content))
            | EventKind::Modify(ModifyKind::Name(_))
    )
}

fn handle_event(
    event: &Event,
    outbox: &Path,
    progress: &Path,
    venture_root: &str,
    app: &AppHandle,
) {
    if !is_settled_event(&event.kind) {
        return;
    }
    for path in &event.paths {
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let kind = if path.starts_with(outbox) {
            "handoff:result"
        } else if path.starts_with(progress) {
            "handoff:progress"
        } else {
            continue;
        };
        emit_file(path, kind, venture_root, app);
    }
}

fn emit_file(path: &Path, kind: &str, venture_root: &str, app: &AppHandle) {
    let body = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return, // file vanished or unreadable - skip
    };
    let run_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        // progress files use `<runId>_<timestamp>.json` - strip the suffix
        .split('_')
        .next()
        .unwrap_or("unknown")
        .to_string();
    let payload = HandoffEvent {
        run_id,
        venture_root: venture_root.to_string(),
        body,
    };
    let _ = app.emit(kind, payload);
}

fn backfill(dir: &Path, kind: &str, venture_root: &str, app: &AppHandle) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("json") {
            emit_file(&path, kind, venture_root, app);
        }
    }
}
