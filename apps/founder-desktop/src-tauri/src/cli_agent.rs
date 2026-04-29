//! CLI-agent bridge — subscription-mode providers.
//!
//! When a provider is configured with `mode = 'subscription'` we don't hit
//! the HTTP API at all. We spawn the vendor's own CLI (`claude`, `codex`,
//! `gemini`) and let it authenticate against the user's consumer
//! subscription (Claude Pro / ChatGPT Plus / Gemini Advanced). Credentials
//! live wherever the CLI stores them (`~/.claude/.credentials.json`,
//! `~/.codex/auth.json`, etc.) — we never touch them directly.
//!
//! This is the same shape Orca uses: shell-out instead of native OAuth.
//! Adding a new subscription agent is a single row in [`agent_config`].
//!
//! ### Tauri commands
//!
//! * `cli_agent_check(agent)` — probe `<cli> --version`, hint at signed-in
//!   state by checking for the vendor's credentials file on disk.
//! * `cli_agent_login(agent, requestId)` — spawn `<cli> <login-args>`, tee
//!   stdout/stderr over `cli-login-output` events so the UI can show the
//!   auth URL the CLI prints, fire `cli-login-done` on exit.
//! * `cli_agent_stream(agent, prompt, requestId)` — spawn the CLI in
//!   non-interactive mode with the user's prompt, pipe stdout lines back
//!   as `llm-delta` events, emit `llm-done` / `llm-cancel` / `llm-error`
//!   on the exact same channels as [`crate::llm::llm_stream`] so the TS
//!   `streamChat` wrapper doesn't need to branch on transport.
//!
//! ### Cancellation
//!
//! We reuse [`crate::llm::CancelRegistry`] so one unified `llm_cancel`
//! command stops whichever transport is in flight. The stream loop races
//! `next_line()` against `cancel_notify.notified()` in a `tokio::select!`
//! so an abort doesn't have to wait for the next line of CLI output.
//! On cancel we send SIGTERM / taskkill via `child.start_kill()` — the
//! CLI stops generating and we emit `llm-cancel` with whatever text we
//! buffered.
//!
//! ### Windows note
//!
//! `claude` / `codex` / `gemini` on Windows are almost always `.cmd`
//! shims installed by npm, pip, or the vendor installer. `CreateProcessW`
//! (what Rust's `Command` uses under the hood) doesn't honor `PATHEXT`
//! automatically, so `Command::new("claude")` fails to locate
//! `claude.cmd`. We resolve the full path manually in [`resolve_binary`]
//! by walking PATH + PATHEXT ourselves. That way the CLI is invoked
//! directly — no `cmd.exe /C` wrapper — so prompts containing `&`, `|`,
//! `>`, `%`, quotes, or newlines go through unescaped.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Notify;

use crate::llm::CancelRegistry;

// ──────────────────────────────────────────────
// Per-agent config
// ──────────────────────────────────────────────

/// Declarative per-agent CLI config. Adding a new subscription provider
/// is a single row below plus a match arm in [`signed_in_guess`].
///
/// * `binary` — the command name the user runs. We resolve this against
///   PATH (and PATHEXT on Windows) ourselves.
/// * `login_args` — literal argv for the vendor's sign-in subcommand.
/// * `stream_args` — argv template for a non-interactive prompt run.
///   When `prompt_via_stdin` is false, exactly one element must be the
///   literal `"{PROMPT}"` — it's replaced with the user's prompt at
///   spawn time, never shell-escaped. When `prompt_via_stdin` is true,
///   the placeholder must be absent — the prompt is piped to the child's
///   stdin instead, so it can exceed the OS argv limit.
/// * `prompt_via_stdin` — pipe the user prompt through stdin instead of
///   substituting it into argv. Required for Claude on Windows: with
///   long chat histories the argv size hits CMD_LIMIT (8191 chars) and
///   `CreateProcessW` fails with `ERROR_FILENAME_EXCED_RANGE` (206),
///   which we used to misreport as "Is the CLI installed and signed in?".
///   `E2BIG` (7) is the equivalent failure on Linux/macOS. The vendor
///   CLI must support reading the prompt from stdin in this mode
///   (`claude -p` does — it's the same pattern the prompt-master
///   `claude-cli` transport and the builder-extension build runner use).
struct CliConfig {
    binary: &'static str,
    login_args: &'static [&'static str],
    stream_args: &'static [&'static str],
    prompt_via_stdin: bool,
}

/// Map a provider id from TS to its CLI config. Returns `None` for
/// providers that have no subscription CLI (e.g. DeepSeek, Grok,
/// Perplexity, Ollama) — the frontend should only ever invoke these
/// commands with agent ids from the subscription-supporting set.
fn agent_config(agent: &str) -> Option<CliConfig> {
    match agent {
        // Anthropic Claude Code. `claude -p` is print mode: non-interactive,
        // writes the reply to stdout, exits. With no positional prompt
        // argument the CLI reads the prompt from stdin, which is how we
        // ship it — argv-substituted prompts hit Windows' 8191-char
        // CMD_LIMIT once chat history accumulates. `claude login` kicks
        // off OAuth against console.anthropic.com in the user's default
        // browser; the CLI polls until the token lands in
        // `~/.claude/.credentials.json`, then prints a success line and
        // exits. Works off the user's Claude Pro subscription.
        "anthropic" => Some(CliConfig {
            binary: "claude",
            login_args: &["login"],
            stream_args: &["-p"],
            prompt_via_stdin: true,
        }),
        // OpenAI Codex. `codex exec "<prompt>"` is the non-interactive
        // subcommand; `codex login` drives the browser OAuth flow and
        // stores tokens under `~/.codex/`. Works off the user's ChatGPT
        // Plus subscription once signed in.
        "openai" => Some(CliConfig {
            binary: "codex",
            login_args: &["login"],
            stream_args: &["exec", "{PROMPT}"],
            prompt_via_stdin: false,
        }),
        // Google Gemini. `gemini auth` covers recent builds; older ones
        // punt to `gcloud auth application-default login`. The inference
        // call uses `gemini -p <prompt>` (gemini-cli requires a value
        // following -p; stdin-only doesn't satisfy it). On Windows the
        // .cmd shim spawn would normally hit Rust 1.78+ CVE-2024-24576
        // mitigation; spawn_argv_compat below routes us through raw_arg
        // for .cmd/.bat targets so prompt content can survive in argv.
        "gemini" => Some(CliConfig {
            binary: "gemini",
            // `gemini auth` opens the OAuth flow; --skip-trust isn't
            // needed for the auth path since auth doesn't read project
            // files.
            login_args: &["auth"],
            // Two protections in one config:
            //
            // (1) `--skip-trust` bypasses gemini-cli's workspace-trust
            //     gate that otherwise refuses to run in an "untrusted"
            //     directory in headless mode.
            //
            // (2) The prompt rides on stdin instead of argv. gemini-cli
            //     requires `-p` to have a value, so we pass a single
            //     space as a placeholder; per gemini's docs that
            //     placeholder is appended to whatever's on stdin, so
            //     a trailing space at the end of the real prompt is
            //     the only side effect. Routing via stdin avoids
            //     Windows cmd.exe mangling multi-line / 1-2 KB prompts
            //     during `%*` substitution in the .cmd shim.
            stream_args: &["--skip-trust", "-p", " "],
            prompt_via_stdin: true,
        }),
        _ => None,
    }
}

// ──────────────────────────────────────────────
// Binary resolution (PATH + PATHEXT)
// ──────────────────────────────────────────────

/// Resolve a bare command name (`"claude"`) to a concrete executable path
/// by walking PATH ourselves. On Windows this is the only way to locate
/// `claude.cmd` shims — `CreateProcessW` doesn't honor PATHEXT. On every
/// platform we also try a list of well-known install locations after
/// PATH, because some vendor installers (e.g. the official Claude Code
/// installer at claude.ai/install.ps1 as of 2.1.x) drop the binary
/// into `~/.local/bin` without adding it to PATH — the user sees
/// "Installation complete!" but `claude --version` still errors until
/// they fix PATH themselves. The fallback table here makes Founder OS
/// work without that manual step.
///
/// Returns `None` if no candidate is found; the caller falls back to
/// `Command::new(binary)` which will produce a clear "program not found"
/// error. That's the right UX: "claude not installed" rather than a
/// misleading "no such path: C:\\…\\claude".
#[cfg(windows)]
fn resolve_binary(name: &str) -> Option<PathBuf> {
    // Respect PATHEXT — user may have a custom order (e.g. ".EXE;.CMD").
    // Default mirrors the standard Windows value.
    let exts = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let exts: Vec<&str> = exts
        .split(';')
        .map(|s| s.trim().trim_start_matches('.'))
        .filter(|s| !s.is_empty())
        .collect();

    // 1. PATH walk -- try PATHEXT extensions FIRST, bare name as a
    // fallback. npm-style installers drop both `gemini` (sh shim,
    // not executable on Windows) and `gemini.cmd` (the real entry
    // point) into %APPDATA%\npm; the old order picked the sh shim
    // and CreateProcessW failed. Reordering means we always prefer
    // a Windows-runnable extension when the user passes a bare name.
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for ext in &exts {
                let candidate = dir.join(format!("{name}.{ext}"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
            // Bare-name fallback (covers "claude.cmd" passed directly,
            // or rare extension-less compiled binaries).
            let base = dir.join(name);
            if base.is_file() {
                return Some(base);
            }
        }
    }

    // 2. Well-known vendor install dirs that some installers forget to
    // add to PATH. Same PATHEXT-first ordering as the PATH walk above.
    for fallback_dir in well_known_install_dirs() {
        for ext in &exts {
            let candidate = fallback_dir.join(format!("{name}.{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        let base = fallback_dir.join(name);
        if base.is_file() {
            return Some(base);
        }
    }

    None
}

/// On Unix Rust's `Command` already honors PATH. We still run the
/// well-known-install-dirs fallback because users on macOS/Linux can
/// hit the same "installer dropped binary but didn't update PATH"
/// trap via `~/.local/bin` — an increasingly common `$PREFIX` for
/// per-user installs.
#[cfg(not(windows))]
fn resolve_binary(name: &str) -> Option<PathBuf> {
    for dir in well_known_install_dirs() {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Directories to probe after PATH when resolving a vendor CLI binary.
/// Ordered most-specific to most-generic. Values are resolved at call
/// time so they pick up the current user's home dir (Rust `Command`
/// doesn't expand `~`).
fn well_known_install_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(home) = crate::home_dir() {
        let sep = if cfg!(windows) { "\\" } else { "/" };
        // `~/.local/bin` — the Claude Code installer (claude.ai/install.ps1)
        // drops `claude.exe` here on Windows without touching PATH, and
        // several pip / cargo / per-user installers use the same convention
        // on macOS/Linux.
        dirs.push(PathBuf::from(format!("{home}{sep}.local{sep}bin")));
        // `~/.claude/local` — an older Claude Code install layout that
        // still shows up on some user machines.
        if cfg!(windows) {
            dirs.push(PathBuf::from(format!("{home}\\.claude\\local")));
        } else {
            dirs.push(PathBuf::from(format!("{home}/.claude/local")));
        }
        // npm user-prefix dirs for npm-global installs of codex / gemini
        // when the user didn't run npm with admin rights.
        if cfg!(windows) {
            if let Ok(appdata) = std::env::var("APPDATA") {
                dirs.push(PathBuf::from(format!("{appdata}\\npm")));
            }
            // pnpm global -- default lives in %LOCALAPPDATA%\pnpm; PNPM_HOME
            // overrides if the user set a custom prefix. Both checked so
            // either configuration resolves the binary.
            if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
                dirs.push(PathBuf::from(format!("{local_appdata}\\pnpm")));
            }
            if let Ok(pnpm_home) = std::env::var("PNPM_HOME") {
                dirs.push(PathBuf::from(pnpm_home));
            }
            // Volta toolchain manager: shims live in
            // %LOCALAPPDATA%\Volta\bin (system install) or
            // %USERPROFILE%\.volta\bin (user install). VOLTA_HOME wins.
            if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
                dirs.push(PathBuf::from(format!("{local_appdata}\\Volta\\bin")));
            }
            dirs.push(PathBuf::from(format!("{home}\\.volta\\bin")));
            if let Ok(volta_home) = std::env::var("VOLTA_HOME") {
                dirs.push(PathBuf::from(format!("{volta_home}\\bin")));
            }
            // bun global bin -- some users install gemini-cli via bun.
            dirs.push(PathBuf::from(format!("{home}\\.bun\\bin")));
        }
    }
    dirs
}

/// Build a fresh tokio `Command` for `config.binary`, resolving to an
/// absolute path on Windows so `.cmd` shims work.
fn make_command(binary: &str) -> Command {
    if let Some(full) = resolve_binary(binary) {
        Command::new(full)
    } else {
        Command::new(binary)
    }
}

/// True when the resolved binary path looks like a Windows batch file
/// (.cmd or .bat). Rust 1.78+ refuses to spawn these via `Command::arg`
/// when args contain CVE-2024-24576 metacharacters (newlines, quotes,
/// `&`, `|`, etc.). The fix is `raw_arg` -- we keep this helper +
/// `apply_args_compat` so every spawn site can opt in uniformly.
#[cfg(windows)]
fn is_batch_path(binary: &str) -> bool {
    let resolved = resolve_binary(binary).unwrap_or_else(|| std::path::PathBuf::from(binary));
    resolved
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("cmd") || s.eq_ignore_ascii_case("bat"))
        .unwrap_or(false)
}

/// Quote a single argument for the Windows command line using
/// msvcrt-compatible rules: wrap in `"..."`, escape embedded quotes
/// with backslashes, double trailing backslashes so they don't escape
/// the closing quote. This is what `Command::arg` does internally;
/// we replicate it for `raw_arg` callers that need to bypass the
/// BatBadBut mitigation while still passing args correctly.
#[cfg(windows)]
fn quote_for_windows_cmdline(arg: &str) -> String {
    let mut out = String::with_capacity(arg.len() + 4);
    out.push('"');
    let mut backslashes: usize = 0;
    for c in arg.chars() {
        if c == '\\' {
            backslashes += 1;
        } else if c == '"' {
            // Double the preceding backslashes, then escape the quote.
            for _ in 0..backslashes * 2 + 1 {
                out.push('\\');
            }
            out.push('"');
            backslashes = 0;
        } else {
            for _ in 0..backslashes {
                out.push('\\');
            }
            backslashes = 0;
            out.push(c);
        }
    }
    // Trailing backslashes must be doubled so they don't escape the
    // closing quote we're about to emit.
    for _ in 0..backslashes * 2 {
        out.push('\\');
    }
    out.push('"');
    out
}

/// Apply args to a `Command`, taking the `.cmd`/`.bat` path on Windows
/// when needed. Callers should use this instead of `cmd.args(args)`
/// directly so the BatBadBut bypass is consistent everywhere.
fn apply_args_compat(cmd: &mut Command, binary: &str, args: &[String]) {
    #[cfg(windows)]
    {
        if is_batch_path(binary) {
            use std::os::windows::process::CommandExt;
            for arg in args {
                cmd.raw_arg(quote_for_windows_cmdline(arg));
            }
            return;
        }
    }
    let _ = binary; // unused on non-Windows
    cmd.args(args);
}

// ──────────────────────────────────────────────
// Installation / sign-in probe
// ──────────────────────────────────────────────

/// Summary of a single CLI's state. Cheap enough to call on every Options
/// tab mount — under ~150ms on a cold cache since each `--version` spawn
/// is bounded by the vendor's own startup time.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    installed: bool,
    /// `--version` stdout, trimmed. `None` if not installed or the CLI
    /// refused to emit a version line.
    version: Option<String>,
    /// Best-effort: vendor's credentials file exists in `$HOME` and is
    /// non-empty. This is a hint, not a guarantee — a revoked or expired
    /// token still leaves the file in place. The real source of truth is
    /// the CLI itself at prompt-send time (stream failure surfaces as
    /// `llm-error` with the CLI's own error message).
    signed_in_hint: bool,
}

#[tauri::command]
pub async fn cli_agent_check(agent: String) -> Result<CliStatus, String> {
    let config = agent_config(&agent).ok_or_else(|| format!("unknown agent: {agent}"))?;

    let output = make_command(config.binary)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .await;

    let (installed, version) = match output {
        Ok(out) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let v = if text.is_empty() { None } else { Some(text) };
            (true, v)
        }
        // Non-zero exit still means the binary ran; we just couldn't read
        // a version. Treat as installed-without-version rather than
        // not-installed, so "claude --version" returning exit 2 doesn't
        // wipe the signed-in hint.
        Ok(_) => (true, None),
        Err(_) => (false, None),
    };

    let signed_in_hint = installed && signed_in_guess(&agent);

    Ok(CliStatus {
        installed,
        version,
        signed_in_hint,
    })
}

/// Check the vendor's credentials file for existence + non-empty size.
/// Deliberately doesn't parse JSON — parsing adds latency and would
/// false-negative on any format change the vendor ships.
fn signed_in_guess(agent: &str) -> bool {
    let Some(home) = crate::home_dir() else {
        return false;
    };
    // Multiple candidates per agent because vendors shuffle these
    // filenames between versions.
    let candidates: &[&str] = match agent {
        "anthropic" => &[".claude/.credentials.json", ".claude/credentials.json"],
        "openai" => &[".codex/auth.json", ".codex/session.json"],
        "gemini" => &[
            // Modern gemini-cli OAuth flow writes these.
            ".gemini/oauth_creds.json",
            ".gemini/google_accounts.json",
            // Older / vendored layouts kept for back-compat.
            ".gemini/credentials.json",
            ".config/gcloud/application_default_credentials.json",
        ],
        _ => &[],
    };
    let sep = if cfg!(windows) { "\\" } else { "/" };
    for rel in candidates {
        // Normalize slashes in the relative path for Windows.
        let rel_norm = if cfg!(windows) {
            rel.replace('/', "\\")
        } else {
            (*rel).to_string()
        };
        let full = format!("{home}{sep}{rel_norm}");
        if let Ok(meta) = std::fs::metadata(&full) {
            if meta.is_file() && meta.len() > 0 {
                return true;
            }
        }
    }
    false
}

// ──────────────────────────────────────────────
// Login flow
// ──────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LoginOutputEvent {
    request_id: String,
    line: String,
    /// `"stdout"` or `"stderr"`. Vendors vary: Codex prints the URL on
    /// stdout, some older Gemini builds use stderr for prompts. The UI
    /// renders both inline but keeps the stream tag for possible styling.
    stream: &'static str,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LoginDoneEvent {
    request_id: String,
    success: bool,
    /// Error message on failure; empty on success.
    message: String,
}

/// Spawn `<cli> <login-args>`, tee stdout/stderr over `cli-login-output`
/// events, and emit `cli-login-done` when the child exits. Returns
/// immediately — the real work runs inside a `tokio::spawn`.
///
/// The login subprocess itself handles the browser dance (the CLI prints
/// a URL, launches the default browser, polls for completion). We don't
/// need a loopback server, a custom protocol, or a BrowserWindow — the
/// vendor's flow already works from the terminal and we're just proxying
/// it into the app's UI.
#[tauri::command]
pub async fn cli_agent_login(
    app: AppHandle,
    agent: String,
    request_id: String,
) -> Result<(), String> {
    let config = agent_config(&agent).ok_or_else(|| format!("unknown agent: {agent}"))?;
    let handle = app.clone();
    tokio::spawn(async move {
        let result = run_login(&handle, &config, &request_id).await;
        match result {
            Ok(success) => {
                let _ = handle.emit(
                    "cli-login-done",
                    LoginDoneEvent {
                        request_id: request_id.clone(),
                        success,
                        message: String::new(),
                    },
                );
            }
            Err(e) => {
                let _ = handle.emit(
                    "cli-login-done",
                    LoginDoneEvent {
                        request_id: request_id.clone(),
                        success: false,
                        message: e,
                    },
                );
            }
        }
    });
    Ok(())
}

async fn run_login(
    app: &AppHandle,
    config: &CliConfig,
    request_id: &str,
) -> Result<bool, String> {
    let mut command = make_command(config.binary);
    let login_args: Vec<String> = config.login_args.iter().map(|s| (*s).to_string()).collect();
    apply_args_compat(&mut command, config.binary, &login_args);
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!(
                "failed to spawn `{} {}`: {e}. Is the CLI installed and on PATH?",
                config.binary,
                config.login_args.join(" ")
            )
        })?;

    // Tee both pipes concurrently so auth URLs / prompts surface as soon
    // as the vendor writes them, not after the child exits.
    if let Some(rd) = child.stdout.take() {
        let app = app.clone();
        let id = request_id.to_string();
        tokio::spawn(async move {
            let mut lines = BufReader::new(rd).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app.emit(
                    "cli-login-output",
                    LoginOutputEvent {
                        request_id: id.clone(),
                        line,
                        stream: "stdout",
                    },
                );
            }
        });
    }
    if let Some(rd) = child.stderr.take() {
        let app = app.clone();
        let id = request_id.to_string();
        tokio::spawn(async move {
            let mut lines = BufReader::new(rd).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app.emit(
                    "cli-login-output",
                    LoginOutputEvent {
                        request_id: id.clone(),
                        line,
                        stream: "stderr",
                    },
                );
            }
        });
    }

    let status = child.wait().await.map_err(|e| format!("wait failed: {e}"))?;
    Ok(status.success())
}

// ──────────────────────────────────────────────
// Stream a prompt through the CLI
// ──────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStreamRequest {
    pub request_id: String,
    pub agent: String,
    pub prompt: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DeltaEvent {
    request_id: String,
    delta: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DoneEvent {
    request_id: String,
    text: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CancelEvent {
    request_id: String,
    text: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ErrorEvent {
    request_id: String,
    message: String,
}

/// Translate a `Command::spawn` failure into a user-facing message that
/// reflects the actual OS-level cause instead of the generic "Is the CLI
/// installed and signed in?" we used to show for everything.
///
/// Three distinguishable cases:
///
/// * Argv too long — `ERROR_FILENAME_EXCED_RANGE` (206) on Windows when
///   the full command line exceeds `CMD_LIMIT` (8191 chars), `E2BIG` (7)
///   on Linux/macOS when it exceeds `ARG_MAX`. This is the long-context
///   chat bug: idea-canvas + history accumulates past the limit and
///   `CreateProcessW` rejects the spawn before the CLI ever runs. The
///   message points at the real fix (shorter prompt or new chat) instead
///   of sending the user to re-check `claude login`.
/// * Binary not found — `ENOENT`/`NotFound`. The classic "CLI not
///   installed" case; we keep the install/sign-in hint here since that's
///   actually what's wrong.
/// * Anything else — surface the raw OS message verbatim (permissions,
///   exec format, etc.) so we don't paper over surprises.
fn spawn_error_message(
    config: &CliConfig,
    args: &[String],
    prompt_len: usize,
    err: &std::io::Error,
) -> String {
    // Windows: 206 = ERROR_FILENAME_EXCED_RANGE.
    // Unix:    7   = E2BIG (argument list too long).
    // Both surface here because Rust's `Command::spawn` returns the raw
    // CreateProcessW / execve errno without translating to ErrorKind.
    let os = err.raw_os_error();
    let argv_too_long = matches!(os, Some(206) | Some(7))
        || err.kind() == std::io::ErrorKind::ArgumentListTooLong;

    if argv_too_long {
        // Estimate the argv size so the user has a concrete number to
        // reason about. Joining args with spaces approximates what the
        // OS sees once `CreateProcessW` re-quotes them.
        let argv_len: usize = args.iter().map(|a| a.len() + 1).sum();
        return format!(
            "Prompt too long for the command line ({argv_len} chars in argv, {prompt_len} chars in prompt). The OS rejected the spawn before {} could run. Try shortening the conversation or starting a fresh chat.",
            config.binary,
        );
    }

    if err.kind() == std::io::ErrorKind::NotFound {
        return format!(
            "Could not find `{}` on PATH. Is the CLI installed and signed in?",
            config.binary,
        );
    }

    format!(
        "failed to spawn `{} {}`: {err}",
        config.binary,
        args.join(" "),
    )
}

/// Run the configured CLI with the user's prompt in non-interactive mode,
/// streaming stdout back over `llm-delta`. Emits `llm-done` on clean
/// exit, `llm-cancel` on user abort, `llm-error` on failure — same
/// channels as [`crate::llm::llm_stream`] so the TS `streamChat` wrapper
/// handles both transports identically.
///
/// The CLIs don't deliver token-level granularity — stdout arrives in
/// whatever chunks the vendor decided to flush. Usually that's a line
/// (or a few tokens at a time for rendering markdown), which still feels
/// "streamed" in the UI. We emit one `llm-delta` per line so the caret
/// visibly advances even on whole-line buffering.
#[tauri::command]
pub async fn cli_agent_stream(
    app: AppHandle,
    registry: State<'_, CancelRegistry>,
    req: CliStreamRequest,
) -> Result<(), String> {
    // Register cancel flag synchronously before the spawn, same pattern
    // as `llm_stream`. If we did this inside the task we'd race an
    // immediate `llm_cancel` invocation from TS.
    let cancel = registry.register(&req.request_id);

    let config = agent_config(&req.agent).ok_or_else(|| format!("unknown agent: {}", req.agent))?;
    let handle = app.clone();
    let request_id = req.request_id.clone();
    let prompt = req.prompt.clone();

    tokio::spawn(async move {
        let result = run_stream(&handle, config, &prompt, &request_id, cancel).await;
        if let Err(message) = result {
            let _ = handle.emit(
                "llm-error",
                ErrorEvent {
                    request_id: request_id.clone(),
                    message,
                },
            );
        }
        if let Some(reg) = handle.try_state::<CancelRegistry>() {
            reg.remove(&request_id);
        }
    });
    Ok(())
}

async fn run_stream(
    app: &AppHandle,
    config: CliConfig,
    prompt: &str,
    request_id: &str,
    cancel: Arc<(AtomicBool, Notify)>,
) -> Result<(), String> {
    // Build argv. In stdin mode the prompt is piped to the child after
    // spawn — never substituted into argv — so it can exceed the OS
    // command-line limit (Windows CMD_LIMIT 8191 chars / Linux ARG_MAX).
    // In argv mode the prompt replaces the literal `{PROMPT}` placeholder
    // as a single argument, newlines and special chars intact.
    let args: Vec<String> = config
        .stream_args
        .iter()
        .map(|s| {
            if *s == "{PROMPT}" && !config.prompt_via_stdin {
                prompt.to_string()
            } else {
                (*s).to_string()
            }
        })
        .collect();

    let stdin_cfg = if config.prompt_via_stdin {
        Stdio::piped()
    } else {
        Stdio::null()
    };

    let mut command = make_command(config.binary);
    apply_args_compat(&mut command, config.binary, &args);
    let mut child = command
        .stdin(stdin_cfg)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| spawn_error_message(&config, &args, prompt.len(), &e))?;

    if config.prompt_via_stdin {
        if let Some(mut stdin) = child.stdin.take() {
            use tokio::io::AsyncWriteExt;
            // Write-then-shutdown signals EOF so the CLI knows the prompt
            // is complete and can start generating. Errors here typically
            // mean the child died before reading — surface them so we
            // don't hang waiting for stdout that will never come.
            stdin
                .write_all(prompt.as_bytes())
                .await
                .map_err(|e| format!("failed to write prompt to {} stdin: {e}", config.binary))?;
            stdin
                .shutdown()
                .await
                .map_err(|e| format!("failed to close {} stdin: {e}", config.binary))?;
        }
    }

    let (cancel_flag, cancel_notify) = &*cancel;
    let mut accumulated = String::new();

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "no stdout handle".to_string())?;
    let mut reader = BufReader::new(stdout).lines();

    // Drain stderr in the background — we only surface it if the child
    // exits non-zero, in which case its content becomes the error
    // message. If we didn't drain, a verbose vendor banner on stderr
    // could fill the pipe buffer and deadlock the child.
    let stderr_accum: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    if let Some(rd) = child.stderr.take() {
        let accum = stderr_accum.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(rd).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(mut s) = accum.lock() {
                    s.push_str(&line);
                    s.push('\n');
                }
            }
        });
    }

    // Reader loop mirrors the SSE loop in `llm::consume_sse`: race
    // `next_line()` against cancel, emit deltas, stop on EOF or cancel.
    loop {
        let mut notified = std::pin::pin!(cancel_notify.notified());
        notified.as_mut().enable();

        if cancel_flag.load(Ordering::SeqCst) {
            let _ = child.start_kill();
            emit_cancel(app, request_id, accumulated);
            return Ok(());
        }

        let line_result = tokio::select! {
            biased;
            _ = &mut notified => {
                let _ = child.start_kill();
                emit_cancel(app, request_id, accumulated);
                return Ok(());
            }
            l = reader.next_line() => l,
        };

        match line_result {
            Ok(Some(line)) => {
                // Re-append the newline BufReader stripped so the UI
                // sees the CLI's original shape (preserves paragraph
                // breaks in markdown output).
                let chunk = format!("{line}\n");
                accumulated.push_str(&chunk);
                let _ = app.emit(
                    "llm-delta",
                    DeltaEvent {
                        request_id: request_id.to_string(),
                        delta: chunk,
                    },
                );
            }
            Ok(None) => break, // stdout closed, wait for exit below
            Err(e) => return Err(format!("stdout read error: {e}")),
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("wait failed: {e}"))?;

    if status.success() {
        // Trim the single trailing newline added by the last-line
        // formatter. Interior newlines (paragraph breaks) are preserved.
        let text = accumulated.trim_end_matches('\n').to_string();
        let _ = app.emit(
            "llm-done",
            DoneEvent {
                request_id: request_id.to_string(),
                text,
            },
        );
        Ok(())
    } else {
        let err_msg = stderr_accum
            .lock()
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("{} exited with status {status}", config.binary));
        Err(err_msg)
    }
}

fn emit_cancel(app: &AppHandle, request_id: &str, text: String) {
    let _ = app.emit(
        "llm-cancel",
        CancelEvent {
            request_id: request_id.to_string(),
            text,
        },
    );
}
