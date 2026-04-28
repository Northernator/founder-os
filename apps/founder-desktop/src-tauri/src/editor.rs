//! Open files in the user's code editor.
//!
//! ### Resolution order
//! 1. If the caller passes a non-empty `preferred_editor`, ONLY that is tried.
//!    The user explicitly chose, so silent fallback would mask the failure
//!    (and could surprise them by opening a different editor than configured).
//!    A preferred-editor failure surfaces as an error.
//! 2. Otherwise: walk the built-in candidate chain — `code`, `cursor`,
//!    `windsurf`, `codium` via PATH, then OS-specific install locations.
//!    First successful spawn wins.
//!
//! ### Preferred editor formats accepted
//! - Bare command name on PATH: `code`, `cursor`, `notepad++`, `subl` …
//! - Absolute path to an executable: `C:\\Tools\\nvim\\bin\\nvim.exe`
//! - Custom template containing the literal `{path}` placeholder:
//!   `notepad++ -multiInst "{path}"`. The whole template is shell-evaluated
//!   so quoting works as the user expects in their native shell.
//!
//! ### Windows note
//! `code` / `cursor` ship as `.cmd` shims, which `CreateProcessW` can't launch
//! directly. We wrap every spawn in `cmd.exe /C`, which also gives us a real
//! exit status — "not found" returns non-zero so the chain falls through
//! instead of silently "succeeding".
use super::expand_tilde;

#[cfg(windows)]
fn spawn_editor(cmd: &str, path: &str) -> std::io::Result<()> {
    use std::io;
    // `cmd /C <editor> <path>` — lets us use .cmd shims and get a real
    // non-zero exit when the editor isn't found.
    let output = std::process::Command::new("cmd")
        .args(["/C", cmd, path])
        .output()?;
    if output.status.success() {
        return Ok(());
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        format!(
            "exit {}: {}",
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stderr).trim()
        ),
    ))
}

#[cfg(not(windows))]
fn spawn_editor(cmd: &str, path: &str) -> std::io::Result<()> {
    // On Unix, PATH lookup and file-not-found both surface through spawn().
    std::process::Command::new(cmd).arg(path).spawn()?;
    Ok(())
}

/// Run a free-form shell command line. Used when the user's preferred-editor
/// string contains the `{path}` placeholder (post-substitution we hand the
/// whole line to the OS shell so quoting behaves as the user expects).
///
/// On Windows we use `cmd /C` and demand `success()` — same rationale as
/// `spawn_editor` (CreateProcessW can't run .cmd shims directly, and a
/// successful exit is the only way to know we didn't silently no-op).
///
/// On Unix we use `sh -c` and `spawn()` — most editors fork into the
/// background, so waiting on them would block the call.
#[cfg(windows)]
fn spawn_shell_line(line: &str) -> std::io::Result<()> {
    use std::io;
    let output = std::process::Command::new("cmd")
        .args(["/C", line])
        .output()?;
    if output.status.success() {
        return Ok(());
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        format!(
            "exit {}: {}",
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stderr).trim()
        ),
    ))
}

#[cfg(not(windows))]
fn spawn_shell_line(line: &str) -> std::io::Result<()> {
    std::process::Command::new("sh").args(["-c", line]).spawn()?;
    Ok(())
}

/// Substitute `{path}` in a template with a properly-quoted version of `path`.
/// Quoting strategy:
/// - Windows: wrap in double quotes (`cmd.exe`'s native quoting). Escape any
///   embedded `"` as `\"` — rare in real file paths but possible in hand-typed
///   ones.
/// - Unix: wrap in single quotes for sh. Embedded `'` become `'\''` (POSIX
///   sh-quoting idiom).
fn substitute_path(template: &str, path: &str) -> String {
    #[cfg(windows)]
    let quoted = format!("\"{}\"", path.replace('"', "\\\""));
    #[cfg(not(windows))]
    let quoted = format!("'{}'", path.replace('\'', "'\\''"));
    template.replace("{path}", &quoted)
}

#[tauri::command]
pub fn open_in_editor(
    path: String,
    preferred_editor: Option<String>,
) -> Result<(), String> {
    let resolved = expand_tilde(&path);
    let p = std::path::Path::new(&resolved);
    if !p.exists() {
        return Err(format!("path does not exist: {}", p.display()));
    }

    // 1. User-set preference wins, with no fallback. If the user explicitly
    //    chose an editor, silently using a different one would be worse than
    //    surfacing the failure.
    if let Some(pref) = preferred_editor.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let result = if pref.contains("{path}") {
            spawn_shell_line(&substitute_path(pref, &resolved))
        } else {
            spawn_editor(pref, &resolved)
        };
        return result.map_err(|e| {
            format!(
                "preferred editor '{}' failed: {}. Update Editor in Options or set to Auto-detect.",
                pref, e
            )
        });
    }

    // 2. Auto-detect — walk the built-in chain. Identical behaviour to the
    //    original implementation; preserved as the no-config default.
    let mut candidates: Vec<String> = vec![
        "code".into(),
        "cursor".into(),
        "windsurf".into(),
        "codium".into(),
    ];

    #[cfg(windows)]
    {
        let local = std::env::var("LOCALAPPDATA")
            .unwrap_or_else(|_| "C:\\Users\\Public\\AppData\\Local".into());
        let pf = std::env::var("ProgramFiles")
            .unwrap_or_else(|_| "C:\\Program Files".into());
        let pf86 = std::env::var("ProgramFiles(x86)")
            .unwrap_or_else(|_| "C:\\Program Files (x86)".into());
        candidates.extend([
            format!("{}\\Programs\\Microsoft VS Code\\bin\\code.cmd", local),
            format!("{}\\Microsoft VS Code\\bin\\code.cmd", pf),
            format!("{}\\Microsoft VS Code\\bin\\code.cmd", pf86),
            format!("{}\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd", local),
        ]);
    }

    #[cfg(target_os = "macos")]
    {
        candidates.extend([
            "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code".into(),
            "/Applications/Cursor.app/Contents/Resources/app/bin/cursor".into(),
            "/Applications/VSCodium.app/Contents/Resources/app/bin/codium".into(),
        ]);
    }

    let mut errors = Vec::new();
    for cmd in &candidates {
        match spawn_editor(cmd, &resolved) {
            Ok(()) => return Ok(()),
            Err(e) => errors.push(format!("{}: {}", cmd, e)),
        }
    }

    Err(format!(
        "No editor found. Tried: {}. Install VS Code / Cursor and ensure it's on PATH, or set a custom command in Options ▸ Editor.",
        errors.join("; ")
    ))
}
