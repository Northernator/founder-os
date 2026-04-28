use serde::Serialize;
use tauri_plugin_sql::{Migration, MigrationKind};

mod brand_checks;
mod brand_pack;
mod cli_agent;
mod editor;
mod handoff_watcher;
mod llm;
mod pdf;
mod secrets;

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/// Expand a leading `~` or `~/...` to the user's home directory.
/// Rust's `Path` doesn't expand `~` (that's a shell feature), so any path
/// stored in the DB from an earlier free-text input round will be literal.
/// We resolve via `USERPROFILE` on Windows and `HOME` elsewhere.
pub(crate) fn expand_tilde(input: &str) -> String {
    if input == "~" {
        return home_dir().unwrap_or_else(|| input.to_string());
    }
    if let Some(rest) = input.strip_prefix("~/").or_else(|| input.strip_prefix("~\\")) {
        if let Some(home) = home_dir() {
            let sep = if cfg!(windows) { "\\" } else { "/" };
            return format!("{}{}{}", home, sep, rest);
        }
    }
    input.to_string()
}

pub(crate) fn home_dir() -> Option<String> {
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE").ok()
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME").ok()
    }
}

// ──────────────────────────────────────────────
// Tauri commands
// ──────────────────────────────────────────────

/// Open a native folder picker and return the selected path.
/// tauri-plugin-dialog v2 uses a callback, so we bridge to async via a oneshot channel.
#[tauri::command]
async fn pick_venture_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .pick_folder(move |folder| {
            let _ = tx.send(folder.map(|p| p.to_string()));
        });
    rx.await.map_err(|e| e.to_string())
}

/// Read a file from disk and return its contents as a string.
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let resolved = expand_tilde(&path);
    std::fs::read_to_string(&resolved).map_err(|e| e.to_string())
}

/// Write a string to a file on disk (creates parent directories as needed).
#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    let resolved = expand_tilde(&path);
    if let Some(parent) = std::path::Path::new(&resolved).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&resolved, content).map_err(|e| e.to_string())
}

/// List files in a directory.
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<String>, String> {
    let entries = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        files.push(entry.path().to_string_lossy().to_string());
    }
    Ok(files)
}

/// Create the venture directory skeleton.
/// `root_path` is the venture root; `dirs` is a list of relative paths to
/// create beneath it. Uses `create_dir_all` so existing dirs are a no-op.
/// Called from the frontend with VENTURE_DIR_SKELETON from @founder-os/workspace-core
/// so the skeleton stays single-sourced in TS.
#[tauri::command]
fn create_venture_dirs(root_path: String, dirs: Vec<String>) -> Result<(), String> {
    let root = std::path::Path::new(&root_path);
    std::fs::create_dir_all(root)
        .map_err(|e| format!("failed to create root '{}': {}", root.display(), e))?;
    for rel in dirs {
        let full = root.join(&rel);
        std::fs::create_dir_all(&full)
            .map_err(|e| format!("failed to create '{}': {}", full.display(), e))?;
    }
    Ok(())
}

/// True if a path exists (file or directory). Used by the pipeline-runner
/// `Filesystem` adapter — its node-side equivalent is `fs.existsSync`.
#[tauri::command]
fn path_exists(path: String) -> bool {
    let resolved = expand_tilde(&path);
    std::path::Path::new(&resolved).exists()
}

/// `mkdir -p`. Idempotent: succeeds if the directory already exists.
/// Used by the pipeline-runner `Filesystem` adapter — its node-side
/// equivalent is `fs.mkdirSync(path, { recursive: true })`.
#[tauri::command]
fn mkdir_p(path: String) -> Result<(), String> {
    let resolved = expand_tilde(&path);
    std::fs::create_dir_all(&resolved)
        .map_err(|e| format!("failed to mkdir '{}': {}", resolved, e))
}

/// Single dir-walk entry returned by `list_dir_recursive`. Mirrors the bits of
/// `fs.Dirent` + `fs.Stats` the WebView scanner needs (no `node:fs` available
/// over there) — `path` is absolute, `is_dir` lets the JS side filter to files,
/// and `size_bytes` / `modified_at` power the artifact list UI.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirEntry {
    path: String,
    is_dir: bool,
    size_bytes: u64,
    /// ISO-8601 UTC. `None` if mtime can't be read or converted.
    modified_at: Option<String>,
}

/// Format a `SystemTime` as an RFC3339-ish UTC string ("2026-04-22T12:34:56Z").
/// Manual implementation so we don't pull in `chrono` for one helper. Returns
/// `None` if the time is before the unix epoch (shouldn't happen but cheap to
/// guard).
fn system_time_to_iso(t: std::time::SystemTime) -> Option<String> {
    let dur = t.duration_since(std::time::UNIX_EPOCH).ok()?;
    let secs = dur.as_secs() as i64;

    // Days since unix epoch + seconds-of-day. We treat every day as 86400s
    // (no leap-seconds), which matches what JS Date does.
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let hour = sod / 3600;
    let minute = (sod / 60) % 60;
    let second = sod % 60;

    // Civil-from-days algorithm by Howard Hinnant — converts days-since-epoch
    // into Y/M/D in proleptic Gregorian.
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

    Some(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hour, minute, second
    ))
}

/// Recursively walk a directory and return every entry beneath it (not the
/// root itself). Used by the desktop artifact scanner — the WebView can't
/// touch `node:fs`, so we expose a richer-than-`list_dir` walk here.
///
/// - Skips entries it can't stat rather than failing the whole walk; a single
///   permission-denied file shouldn't blank out the whole Artifacts tab.
/// - Returns an empty vec if the root doesn't exist (the caller scans many
///   stage dirs and most won't exist on a fresh venture).
/// - Iterative (stack-based) so a deep tree won't blow the call stack.
/// - No symlink-following — `read_dir` follows symlinks by default for the
///   immediate children but we don't recurse through them; cycles are bounded
///   by the explicit stack.
#[tauri::command]
fn list_dir_recursive(path: String) -> Result<Vec<DirEntry>, String> {
    let root = expand_tilde(&path);
    let root_path = std::path::Path::new(&root);
    if !root_path.exists() {
        return Ok(Vec::new());
    }

    let mut out: Vec<DirEntry> = Vec::new();
    let mut stack: Vec<std::path::PathBuf> = vec![root_path.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue, // unreadable dir — skip, don't fail the walk
        };
        for entry in entries.flatten() {
            let entry_path = entry.path();
            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let is_dir = metadata.is_dir();
            let size_bytes = if is_dir { 0 } else { metadata.len() };
            let modified_at = metadata.modified().ok().and_then(system_time_to_iso);

            out.push(DirEntry {
                path: entry_path.to_string_lossy().to_string(),
                is_dir,
                size_bytes,
                modified_at,
            });

            if is_dir {
                stack.push(entry_path);
            }
        }
    }

    Ok(out)
}

/// Reveal a folder (or file) in the OS file manager.
/// - Windows: Explorer
/// - macOS:   Finder
/// - Linux:   xdg-open (delegates to the user's default manager)
///
/// Uses `spawn` not `output` so we don't block on the file manager process.
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let resolved = expand_tilde(&path);
    let p = std::path::Path::new(&resolved);
    if !p.exists() {
        return Err(format!("path does not exist: {}", p.display()));
    }

    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer.exe").arg(&resolved).spawn();

    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&resolved).spawn();

    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open").arg(&resolved).spawn();

    result.map(|_| ()).map_err(|e| e.to_string())
}

/// Delete a directory and everything inside it. Used when a venture is
/// removed — the DB row goes via `db.deleteVenture`, this handles the disk.
/// No-op if the path doesn't exist (useful if the user moved the folder
/// themselves and we're just cleaning the DB record).
#[tauri::command]
fn delete_dir(path: String) -> Result<(), String> {
    let resolved = expand_tilde(&path);
    let p = std::path::Path::new(&resolved);
    if !p.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(p)
        .map_err(|e| format!("failed to remove '{}': {}", p.display(), e))
}

// ──────────────────────────────────────────────
// DB migrations
// ──────────────────────────────────────────────

fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create_initial_tables",
            sql: include_str!("../migrations/0001-init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "llm_settings_and_app_settings",
            sql: include_str!("../migrations/0002-llm-settings.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "venture_default_provider",
            sql: include_str!("../migrations/0003-venture-provider.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "audit_fix_suggestions",
            sql: include_str!("../migrations/0004-audit-fix-suggestions.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "llm_settings_mode",
            sql: include_str!("../migrations/0005-llm-settings-mode.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "chat_provider_column",
            sql: include_str!("../migrations/0006-chat-provider-column.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

// ──────────────────────────────────────────────
// App entry
// ──────────────────────────────────────────────

#[cfg_attr(target_os = "android", tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:founder.db", migrations())
                .build(),
        )
        // Shared registry of in-flight LLM streams. Each `llm_stream` call
        // inserts an `AtomicBool` keyed on `requestId`; `llm_cancel` flips
        // the flag and the streaming task observes it between SSE events
        // and bails out with an `llm-cancel` emit.
        .manage(llm::CancelRegistry::default())
        .manage(handoff_watcher::WatcherRegistry::default())
        .invoke_handler(tauri::generate_handler![
            pick_venture_folder,
            read_file,
            write_file,
            list_dir,
            create_venture_dirs,
            open_path,
            delete_dir,
            path_exists,
            mkdir_p,
            list_dir_recursive,
            llm::llm_stream,
            llm::llm_cancel,
            cli_agent::cli_agent_check,
            cli_agent::cli_agent_login,
            cli_agent::cli_agent_stream,
            secrets::keyring_set,
            secrets::keyring_get,
            secrets::keyring_delete,
            editor::open_in_editor,
            pdf::pdf_extract_text,
            brand_checks::check_domain,
            brand_checks::check_social_handle,
            brand_checks::open_url,
            brand_pack::brand_zip_pack,
            handoff_watcher::start_handoff_watcher,
            handoff_watcher::stop_handoff_watcher,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
