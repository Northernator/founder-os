//! Tauri commands for the backend arc -- slice 5b.
//!
//! Three commands bridge the WebView to the @founder-os/backend-providers Node
//! sidecar. The WebView CAN'T import the Node entry directly (Vite externalises
//! node:child_process + node:http + node:fs, the renderer crashes on access --
//! same blank-screen failure mode the media-providers PM-split memory
//! documents), so every Node-only operation funnels through these commands.
//!
//! Surface:
//!  * `backend_probe_pocketbase(ventureRoot?)` -> { available, binaryPath, resolvedVersion | reason }
//!  * `backend_download_binary(ventureRoot, version?)` -> { downloaded, binaryPath, resolvedVersion | reason }
//!  * `backend_run_stage(ventureRoot, manifestPath, force)` -> { result, engineUsed, checkpointPath }
//!
//! Implementation mirrors crm::* (slice 5b CRM precedent):
//!  1. Find pnpm-workspace.yaml (env override or walk up from cwd/exe)
//!  2. Resolve pnpm via cli_agent::resolve_binary (PATH+PATHEXT on Windows)
//!  3. Spawn `pnpm --filter @founder-os/backend-providers cli -- <subcommand>`
//!  4. Parse the single-line JSON envelope the CLI emits on stdout
//!
//! The CLI lives at packages/backend-providers/src/cli.ts (tsx run by the
//! workspace's "cli" script). Diagnostics go to stderr and are bubbled up in
//! error messages when the JSON parse fails.
//!
//! serve-dev / stop-dev commands are deferred to a follow-up slice -- they
//! are operational concerns the core slice 5b loop doesn't need.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::cli_agent;

// ---------------------------------------------------------------------------
// JSON envelopes -- mirror the shapes in packages/backend-providers/src/cli.ts.
// `untagged` lets us deserialise either the success or the error shape from
// the same stdout line.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum BackendProbePocketbaseResult {
    Available {
        available: bool,
        #[serde(rename = "binaryPath")]
        binary_path: String,
        #[serde(rename = "resolvedVersion")]
        resolved_version: String,
    },
    Unavailable {
        available: bool,
        reason: String,
    },
    Error {
        error: String,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum BackendDownloadBinaryResult {
    Downloaded {
        downloaded: bool,
        #[serde(rename = "binaryPath")]
        binary_path: String,
        #[serde(rename = "resolvedVersion")]
        resolved_version: String,
    },
    NotDownloaded {
        downloaded: bool,
        reason: String,
    },
    Error {
        error: String,
    },
}

/// The serialised StageRunResult the CLI emits inside the run-stage
/// envelope. We deserialise as a raw `serde_json::Value` so we don't
/// have to mirror every nested field -- the WebView is the consumer
/// and re-parses against the @founder-os/domain schema on its side.
#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum BackendRunStageResult {
    Ok {
        result: serde_json::Value,
        #[serde(rename = "engineUsed")]
        engine_used: String,
        #[serde(rename = "checkpointPath", skip_serializing_if = "Option::is_none")]
        checkpoint_path: Option<String>,
    },
    Error {
        error: String,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum BackendProbeSupabaseResult {
    Available {
        available: bool,
        #[serde(rename = "projectUrl")]
        project_url: String,
        version: String,
    },
    Unavailable {
        available: bool,
        reason: String,
    },
    Error {
        error: String,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum BackendSaveSupabaseCredentialsResult {
    Saved {
        saved: bool,
        #[serde(rename = "credentialsPath")]
        credentials_path: String,
    },
    NotSaved {
        saved: bool,
        reason: String,
    },
    Error {
        error: String,
    },
}

// ---------------------------------------------------------------------------
// Public commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn backend_probe_pocketbase(
    venture_root: Option<String>,
) -> Result<BackendProbePocketbaseResult, String> {
    let mut args: Vec<&str> = vec!["probe-pocketbase"];
    if let Some(ref vr) = venture_root {
        args.push("--venture-root");
        args.push(vr.as_str());
    }
    let stdout = run_cli(&args, None).await?;
    parse_envelope::<BackendProbePocketbaseResult>(&stdout)
}

#[tauri::command]
pub async fn backend_download_binary(
    venture_root: String,
    version: Option<String>,
) -> Result<BackendDownloadBinaryResult, String> {
    let mut args: Vec<&str> = vec!["download-binary", "--venture-root", venture_root.as_str()];
    if let Some(ref v) = version {
        args.push("--version");
        args.push(v.as_str());
    }
    // Downloads can be slow -- give them a generous timeout. Mirrors the
    // crm_run_stage 5-minute ceiling.
    let stdout = run_cli(&args, Some(Duration::from_secs(300))).await?;
    parse_envelope::<BackendDownloadBinaryResult>(&stdout)
}

#[tauri::command]
pub async fn backend_run_stage(
    venture_root: String,
    manifest_path: String,
    force: Option<bool>,
) -> Result<BackendRunStageResult, String> {
    let mut args: Vec<&str> = vec![
        "run-stage",
        "--venture-root",
        venture_root.as_str(),
        "--manifest",
        manifest_path.as_str(),
    ];
    if force.unwrap_or(false) {
        args.push("--force");
    }
    // run-stage can do real work (binary spawns, migrations, REST round
    // trips) -- give it the same 5-minute timeout the CRM command uses.
    let stdout = run_cli(&args, Some(Duration::from_secs(300))).await?;
    parse_envelope::<BackendRunStageResult>(&stdout)
}

#[tauri::command]
pub async fn backend_probe_supabase(
    venture_root: String,
    project_url: String,
    anon_key_env_var: Option<String>,
    service_role_key_env_var: Option<String>,
) -> Result<BackendProbeSupabaseResult, String> {
    let mut args: Vec<&str> = vec![
        "probe-supabase",
        "--venture-root",
        venture_root.as_str(),
        "--project-url",
        project_url.as_str(),
    ];
    if let Some(ref v) = anon_key_env_var {
        args.push("--anon-env");
        args.push(v.as_str());
    }
    if let Some(ref v) = service_role_key_env_var {
        args.push("--service-env");
        args.push(v.as_str());
    }
    let stdout = run_cli(&args, Some(Duration::from_secs(30))).await?;
    parse_envelope::<BackendProbeSupabaseResult>(&stdout)
}

#[tauri::command]
pub async fn backend_save_supabase_credentials(
    venture_root: String,
    project_url: String,
    anon_key: String,
    service_role_key: String,
    anon_key_env_var: Option<String>,
    service_role_key_env_var: Option<String>,
) -> Result<BackendSaveSupabaseCredentialsResult, String> {
    let mut args: Vec<&str> = vec![
        "save-supabase-credentials",
        "--venture-root",
        venture_root.as_str(),
        "--project-url",
        project_url.as_str(),
        "--anon-key",
        anon_key.as_str(),
        "--service-role-key",
        service_role_key.as_str(),
    ];
    if let Some(ref v) = anon_key_env_var {
        args.push("--anon-env");
        args.push(v.as_str());
    }
    if let Some(ref v) = service_role_key_env_var {
        args.push("--service-env");
        args.push(v.as_str());
    }
    let stdout = run_cli(&args, Some(Duration::from_secs(15))).await?;
    parse_envelope::<BackendSaveSupabaseCredentialsResult>(&stdout)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Spawn `pnpm --filter @founder-os/backend-providers cli -- <args>` in the
/// workspace root and return stdout. Errors include stderr for diagnosis.
async fn run_cli(args: &[&str], timeout: Option<Duration>) -> Result<String, String> {
    let workspace_root = find_workspace_root().ok_or_else(|| {
        "could not locate pnpm-workspace.yaml -- set FOUNDER_OS_REPO_ROOT env var \
         or launch from a Founder OS workspace"
            .to_string()
    })?;

    let pnpm_path = cli_agent::resolve_binary("pnpm")
        .or_else(|| cli_agent::resolve_binary("pnpm.cmd"))
        .ok_or_else(|| {
            "pnpm not found on PATH -- install pnpm to use backend commands".to_string()
        })?;

    let mut cmd = Command::new(&pnpm_path);
    cmd.arg("--filter")
        .arg("@founder-os/backend-providers")
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
                    "backend-providers CLI timed out after {}s (args: {:?})",
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
            "backend-providers CLI exited with {:?}\nstderr:\n{}\nstdout:\n{}",
            output.status.code(),
            stderr.trim(),
            stdout.trim()
        ));
    }

    // The CLI emits its result envelope as the LAST non-empty line on
    // stdout. Anything before it is pnpm-noise / tsx-load chatter. Walk
    // the lines from the end so we pick the envelope deterministically.
    Ok(stdout)
}

/// Parse a JSON envelope from the CLI's stdout. Returns the deserialised
/// value, OR an error containing the raw stdout when parsing fails (this
/// is the only thing the WebView has to debug a malformed reply).
fn parse_envelope<T: serde::de::DeserializeOwned>(stdout: &str) -> Result<T, String> {
    let last = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .ok_or_else(|| "backend-providers CLI produced no stdout".to_string())?;
    serde_json::from_str::<T>(last).map_err(|e| {
        format!(
            "failed to parse backend-providers CLI envelope: {}\nlast stdout line: {}",
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
