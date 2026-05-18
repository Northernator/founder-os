//! Tauri commands for the media-edit arc -- slice 5b.
//!
//! Four commands bridge the WebView to OpenCut's `bun dev` server. The
//! WebView can't import @founder-os/media-edit-providers/node directly
//! (Vite externalises node:child_process, the renderer crashes on
//! access -- documented blank-screen failure mode), so every Node-only
//! operation funnels through this module.
//!
//! Surface:
//!  * `media_edit_probe_vendor(vendorPath)` -- delegates to the
//!    media-edit-providers CLI (probe-vendor subcommand). Returns
//!    `{ available, vendorPath, version | reason }`.
//!  * `media_edit_serve(vendorPath, port)` -- spawns `bun dev` directly
//!    from Rust (NOT via the CLI -- the bun process has to outlive the
//!    Tauri command return). Returns `{ spawned, pid, serverUrl, serverPort }`.
//!    The webview polls the URL itself to know when bun reports ready.
//!  * `media_edit_kill(pid)` -- sends SIGTERM to the tracked bun process.
//!  * `media_edit_open_browser(url)` -- best-effort OS default-browser
//!    opener. Returns `{ openedBrowser }`.
//!
//! probe_vendor mirrors crm::crm_probe_docker / backend::backend_probe_pocketbase
//! (shells to the workspace CLI). serve/kill/open are NEW shapes because the
//! prior arcs didn't have a long-running webapp dev server tied to the
//! Tauri session.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::cli_agent;

// ---------------------------------------------------------------------------
// JSON envelopes -- mirror the shapes in media-edit-providers/src/cli.ts and
// the contract types in @founder-os/media-edit-core.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum MediaEditProbeVendorResult {
    Available {
        engine: String,
        available: bool,
        #[serde(rename = "vendorPath")]
        vendor_path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        version: Option<String>,
    },
    Unavailable {
        engine: String,
        available: bool,
        reason: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        version: Option<String>,
    },
    Error {
        error: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaEditServeResult {
    pub spawned: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaEditKillResult {
    pub killed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaEditOpenBrowserResult {
    pub opened_browser: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Public commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn media_edit_probe_vendor(
    vendor_path: String,
) -> Result<MediaEditProbeVendorResult, String> {
    let args: Vec<&str> = vec!["probe-vendor", "--vendor-path", vendor_path.as_str()];
    let stdout = run_cli(&args, Some(Duration::from_secs(15))).await?;
    parse_envelope::<MediaEditProbeVendorResult>(&stdout)
}

#[tauri::command]
pub async fn media_edit_serve(
    vendor_path: String,
    port: Option<u16>,
) -> Result<MediaEditServeResult, String> {
    let port = port.unwrap_or(3000);
    let bun_path = cli_agent::resolve_binary("bun")
        .or_else(|| cli_agent::resolve_binary("bun.exe"))
        .ok_or_else(|| {
            "bun not found on PATH -- install from https://bun.sh".to_string()
        })?;

    let mut cmd = Command::new(&bun_path);
    cmd.arg("dev")
        .current_dir(&vendor_path)
        .env("PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Default kill_on_drop is false on tokio::process::Command -- when this
    // function returns, the Child handle drops and the bun process keeps
    // running. The webview tracks the PID and calls media_edit_kill later.

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return Ok(MediaEditServeResult {
                spawned: false,
                pid: None,
                server_url: None,
                server_port: None,
                error: Some(format!("failed to spawn bun: {}", e)),
            });
        }
    };

    let pid = child.id();
    // Detach: forget the Child so its drop doesn't try to reap (which
    // would block tokio's runtime). On Unix this orphans the child to
    // init; on Windows it's a no-op since the handle is closed.
    std::mem::forget(child);

    Ok(MediaEditServeResult {
        spawned: true,
        pid,
        server_url: Some(format!("http://localhost:{}", port)),
        server_port: Some(port),
        error: None,
    })
}

#[tauri::command]
pub async fn media_edit_kill(pid: u32) -> Result<MediaEditKillResult, String> {
    let result = kill_pid(pid);
    match result {
        Ok(()) => Ok(MediaEditKillResult {
            killed: true,
            error: None,
        }),
        Err(e) => Ok(MediaEditKillResult {
            killed: false,
            error: Some(e),
        }),
    }
}

#[tauri::command]
pub async fn media_edit_open_browser(
    url: String,
) -> Result<MediaEditOpenBrowserResult, String> {
    let result = open_url(&url);
    match result {
        Ok(()) => Ok(MediaEditOpenBrowserResult {
            opened_browser: true,
            error: None,
        }),
        Err(e) => Ok(MediaEditOpenBrowserResult {
            opened_browser: false,
            error: Some(e),
        }),
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn kill_pid(pid: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        let status = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| format!("failed to spawn taskkill: {}", e))?;
        if !status.success() {
            return Err(format!("taskkill exited with {:?}", status.code()));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let status = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| format!("failed to spawn kill: {}", e))?;
        if !status.success() {
            return Err(format!("kill exited with {:?}", status.code()));
        }
        Ok(())
    }
}

fn open_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| format!("failed to spawn open: {}", e))?;
        if !status.success() {
            return Err(format!("open exited with {:?}", status.code()));
        }
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        // cmd /c start "" <url> -- the empty quoted string is the window
        // title; without it cmd treats a quoted url as the title and opens
        // an empty start window.
        let status = std::process::Command::new("cmd")
            .args(["/c", "start", "", url])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| format!("failed to spawn cmd start: {}", e))?;
        if !status.success() {
            return Err(format!("cmd start exited with {:?}", status.code()));
        }
        Ok(())
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let status = std::process::Command::new("xdg-open")
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| format!("failed to spawn xdg-open: {}", e))?;
        if !status.success() {
            return Err(format!("xdg-open exited with {:?}", status.code()));
        }
        Ok(())
    }
}

/// Spawn `pnpm --filter @founder-os/media-edit-providers cli -- <args>` and
/// return stdout. Mirrors backend::run_cli exactly.
async fn run_cli(args: &[&str], timeout: Option<Duration>) -> Result<String, String> {
    let workspace_root = find_workspace_root().ok_or_else(|| {
        "could not locate pnpm-workspace.yaml -- set FOUNDER_OS_REPO_ROOT env var \
         or launch from a Founder OS workspace"
            .to_string()
    })?;

    let pnpm_path = cli_agent::resolve_binary("pnpm")
        .or_else(|| cli_agent::resolve_binary("pnpm.cmd"))
        .ok_or_else(|| {
            "pnpm not found on PATH -- install pnpm to use media-edit commands".to_string()
        })?;

    let mut cmd = Command::new(&pnpm_path);
    cmd.arg("--filter")
        .arg("@founder-os/media-edit-providers")
        .arg("cli")
        .arg("--");
    for a in args {
        cmd.arg(a);
    }
    cmd.current_dir(&workspace_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn pnpm: {}", e))?;

    let output = if let Some(d) = timeout {
        match tokio::time::timeout(d, child.wait_with_output()).await {
            Ok(result) => result.map_err(|e| format!("pnpm wait failed: {}", e))?,
            Err(_) => {
                return Err(format!(
                    "media-edit-providers CLI timed out after {}s (args: {:?})",
                    d.as_secs(),
                    args
                ));
            }
        }
    } else {
        child
            .wait_with_output()
            .await
            .map_err(|e| format!("pnpm wait failed: {}", e))?
    };

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    if !output.status.success() {
        return Err(format!(
            "media-edit-providers CLI exited with {:?}\nstderr:\n{}\nstdout:\n{}",
            output.status.code(),
            stderr.trim(),
            stdout.trim()
        ));
    }

    Ok(stdout)
}

fn parse_envelope<T: serde::de::DeserializeOwned>(stdout: &str) -> Result<T, String> {
    let last = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .ok_or_else(|| "media-edit-providers CLI produced no stdout".to_string())?;
    serde_json::from_str::<T>(last).map_err(|e| {
        format!(
            "failed to parse media-edit-providers CLI envelope: {}\nlast stdout line: {}",
            e, last
        )
    })
}

fn find_workspace_root() -> Option<PathBuf> {
    if let Ok(env_root) = std::env::var("FOUNDER_OS_REPO_ROOT") {
        let p = PathBuf::from(env_root);
        if p.join("pnpm-workspace.yaml").exists() {
            return Some(p);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(found) = walk_up_for_marker(&exe, "pnpm-workspace.yaml") {
            return Some(found);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(found) = walk_up_for_marker(&cwd, "pnpm-workspace.yaml") {
            return Some(found);
        }
    }
    None
}

fn walk_up_for_marker(start: &Path, marker: &str) -> Option<PathBuf> {
    let mut current: Option<&Path> = Some(start);
    while let Some(dir) = current {
        if dir.join(marker).exists() {
            return Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    None
}
