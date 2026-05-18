//! Tauri commands for the SOCIAL-MODULE-SPEC arc -- round 3.
//!
//! Four commands bridge the WebView to the @founder-os/social-providers Node
//! sidecar. The WebView CAN'T import the Node entry directly: spawn.ts pulls
//! in node:child_process and postiz-http.ts uses node:fetch; Vite externalises
//! both for the renderer and the resulting stubs throw on access (the blank
//! screen failure mode the media-providers PM-split memory documents).
//!
//! Surface:
//!  * `social_probe_backend(...)`   -> { backend, available, reason }
//!  * `social_login_state(...)`     -> { backend, state: { platform: state }}
//!  * `social_post(payload, ...)`   -> { backend, result, resultPath? }
//!  * `social_open_post_log(root)`  -> ()
//!
//! Implementation mirrors crm::run_cli verbatim:
//!  1. Find pnpm-workspace.yaml (env override or walk up from cwd/exe)
//!  2. Resolve pnpm via cli_agent::resolve_binary (PATH+PATHEXT on Windows)
//!  3. Spawn `pnpm --filter @founder-os/social-providers cli -- <subcommand>`
//!  4. Parse the single-line JSON envelope the CLI emits on stdout
//!
//! social_open_post_log is the odd one out -- it doesn't need the CLI at all
//! because the only work is "compute the posts dir and ask the OS to open it
//! in Finder/Explorer". Doing this in Rust keeps the round trip short and
//! matches the existing `open_path` command's behaviour.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::cli_agent;

// ---------------------------------------------------------------------------
// JSON envelopes -- mirror the shapes in packages/social-providers/src/cli.ts.
// `untagged` lets us deserialise either the success or the error shape from
// the same stdout line.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum SocialProbeResult {
    Available {
        backend: String,
        available: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    Error {
        error: String,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum SocialLoginStateResult {
    Ok {
        backend: String,
        state: serde_json::Map<String, serde_json::Value>,
    },
    Error {
        error: String,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum SocialPostResult {
    Ok {
        backend: String,
        result: serde_json::Value,
        #[serde(rename = "resultPath", skip_serializing_if = "Option::is_none")]
        result_path: Option<String>,
    },
    Error {
        error: String,
    },
}

/// Options for the postiz adapter -- forwarded verbatim to the CLI when the
/// WebView is probing or posting through Postiz. social-poster takes only the
/// optional binary override. The struct keeps the IPC surface stable even as
/// we add backends in future slices.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocialAdapterOpts {
    /// `sp` CLI name or absolute path. Defaults to "sp" on the CLI side.
    #[serde(default)]
    pub sp_binary: Option<String>,
    /// Postiz base URL when backend == "postiz".
    #[serde(default)]
    pub postiz_base_url: Option<String>,
    /// Env var the CLI reads for the Postiz API key.
    #[serde(default)]
    pub postiz_api_key_env: Option<String>,
    /// Reject non-local Postiz hosts when set.
    #[serde(default)]
    pub postiz_allow_remote_only: bool,
}

// ---------------------------------------------------------------------------
// Public commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn social_probe_backend(
    backend: String,
    opts: Option<SocialAdapterOpts>,
) -> Result<SocialProbeResult, String> {
    let opts = opts.unwrap_or_default();
    let mut args: Vec<String> = vec!["probe".into(), "--backend".into(), backend];
    push_adapter_flags(&mut args, &opts);
    let stdout = run_cli(&args_as_strs(&args), None).await?;
    parse_envelope::<SocialProbeResult>(&stdout)
}

#[tauri::command]
pub async fn social_login_state(
    backend: String,
    opts: Option<SocialAdapterOpts>,
) -> Result<SocialLoginStateResult, String> {
    let opts = opts.unwrap_or_default();
    let mut args: Vec<String> = vec!["login-state".into(), "--backend".into(), backend];
    push_adapter_flags(&mut args, &opts);
    // Postiz integration listing can take a couple of seconds on a remote
    // instance; give the call more rope than probe.
    let stdout = run_cli(&args_as_strs(&args), Some(Duration::from_secs(30))).await?;
    parse_envelope::<SocialLoginStateResult>(&stdout)
}

#[tauri::command]
pub async fn social_post(
    payload: serde_json::Value,
    backend: String,
    venture_root: Option<String>,
    opts: Option<SocialAdapterOpts>,
) -> Result<SocialPostResult, String> {
    let opts = opts.unwrap_or_default();

    // Write the payload to a temp file so we don't have to worry about argv
    // length limits on Windows (8191 chars). The CLI reads + parses the file
    // via parseSocialPost; we never have to schema-mirror the payload here.
    let mut tmp = std::env::temp_dir();
    let unique = format!(
        "founder-os-social-{}.json",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    tmp.push(unique);
    let payload_str = serde_json::to_string(&payload)
        .map_err(|e| format!("failed to serialise social payload: {}", e))?;
    std::fs::write(&tmp, payload_str)
        .map_err(|e| format!("failed to write temp payload file: {}", e))?;
    let payload_path = tmp.to_string_lossy().into_owned();

    let mut args: Vec<String> = vec![
        "post".into(),
        "--backend".into(),
        backend,
        "--payload-file".into(),
        payload_path.clone(),
    ];
    if let Some(ref vr) = venture_root {
        args.push("--venture-root".into());
        args.push(vr.clone());
    }
    push_adapter_flags(&mut args, &opts);

    // post() can take minutes for video uploads -- match the social-poster
    // adapter's own default of 5 minutes plus a little headroom.
    let stdout = run_cli(&args_as_strs(&args), Some(Duration::from_secs(360))).await;

    // Best-effort cleanup of the temp file regardless of CLI outcome.
    let _ = std::fs::remove_file(&tmp);

    let stdout = stdout?;
    parse_envelope::<SocialPostResult>(&stdout)
}

/// Open the venture's 13_social/posts/ directory in the OS file manager.
/// Pure Rust -- no CLI roundtrip needed because the only work is "compute the
/// path and shell out to explorer/open/xdg-open". The directory is created if
/// missing so the user lands in a real folder rather than getting an error.
#[tauri::command]
pub async fn social_open_post_log(venture_root: String) -> Result<(), String> {
    let resolved = crate::expand_tilde(&venture_root);
    let posts_dir = std::path::Path::new(&resolved).join("13_social").join("posts");
    if !posts_dir.exists() {
        std::fs::create_dir_all(&posts_dir).map_err(|e| {
            format!(
                "failed to create 13_social/posts/ at '{}': {}",
                posts_dir.display(),
                e
            )
        })?;
    }
    open_in_file_manager(&posts_dir)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn push_adapter_flags(args: &mut Vec<String>, opts: &SocialAdapterOpts) {
    if let Some(ref bin) = opts.sp_binary {
        args.push("--sp-binary".into());
        args.push(bin.clone());
    }
    if let Some(ref url) = opts.postiz_base_url {
        args.push("--postiz-base-url".into());
        args.push(url.clone());
    }
    if let Some(ref env) = opts.postiz_api_key_env {
        args.push("--postiz-api-key-env".into());
        args.push(env.clone());
    }
    if opts.postiz_allow_remote_only {
        args.push("--postiz-allow-remote-only".into());
    }
}

fn args_as_strs(args: &[String]) -> Vec<&str> {
    args.iter().map(String::as_str).collect()
}

/// Spawn `pnpm --filter @founder-os/social-providers cli -- <args>` in the
/// workspace root and return stdout. Errors include stderr for diagnosis.
/// Verbatim copy of crm::run_cli with the package filter swapped.
async fn run_cli(args: &[&str], timeout: Option<Duration>) -> Result<String, String> {
    let workspace_root = find_workspace_root().ok_or_else(|| {
        "could not locate pnpm-workspace.yaml -- set FOUNDER_OS_REPO_ROOT env var \
         or launch from a Founder OS workspace"
            .to_string()
    })?;

    let pnpm_path = cli_agent::resolve_binary("pnpm")
        .or_else(|| cli_agent::resolve_binary("pnpm.cmd"))
        .ok_or_else(|| {
            "pnpm not found on PATH -- install pnpm to use social commands".to_string()
        })?;

    let mut cmd = Command::new(&pnpm_path);
    cmd.arg("--filter")
        .arg("@founder-os/social-providers")
        .arg("cli")
        .arg("--");
    for a in args {
        cmd.arg(a);
    }
    cmd.current_dir(&workspace_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let child = cmd.spawn().map_err(|e| format!("failed to spawn pnpm: {}", e))?;

    let output = if let Some(d) = timeout {
        match tokio::time::timeout(d, child.wait_with_output()).await {
            Ok(result) => result.map_err(|e| format!("pnpm wait failed: {}", e))?,
            Err(_) => {
                return Err(format!(
                    "social-providers CLI timed out after {}s (args: {:?})",
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
            "social-providers CLI exited with {:?}\nstderr:\n{}\nstdout:\n{}",
            output.status.code(),
            stderr.trim(),
            stdout.trim()
        ));
    }

    Ok(stdout)
}

/// Parse a JSON envelope from the CLI's stdout. Returns the deserialised
/// value, OR an error containing the raw stdout when parsing fails.
fn parse_envelope<T: serde::de::DeserializeOwned>(stdout: &str) -> Result<T, String> {
    let last = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .ok_or_else(|| "social-providers CLI produced no stdout".to_string())?;
    serde_json::from_str::<T>(last).map_err(|e| {
        format!(
            "failed to parse social-providers CLI envelope: {}\nlast stdout line: {}",
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

fn open_in_file_manager(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer.exe").arg(path).spawn();

    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(path).spawn();

    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open").arg(path).spawn();

    result.map(|_| ()).map_err(|e| e.to_string())
}
