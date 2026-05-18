//! Tauri commands for the media arc -- slice 3b.
//!
//! Four commands bridge the WebView to the @founder-os/media-providers Node
//! sidecar so the desktop app can drive HyperFrames (probe / doctor /
//! bootstrap / single-shot render) without the renderer ever touching a
//! Node-only import. The WebView CAN'T import @founder-os/media-providers/node
//! directly because Vite externalises node:child_process + node:fs -- the
//! renderer crashes on access (same blank-screen failure mode the
//! media-providers PM-split memory documents from slice 5b's regression).
//!
//! Surface (matches the JSDoc in run-media-stage.ts probeHyperframesViaTauri):
//!  * `hf_probe()`                                  -> { available, version | reason }
//!  * `hf_doctor(ventureRoot)`                      -> { ok, raw | reason }
//!  * `hf_bootstrap(ventureRoot)`                   -> { ok, projectPath, freshlyBootstrapped, installedBlocks, installedComponents | reason }
//!  * `hf_render(ventureRoot, shotJson, outDir)`    -> { ok, path, durationSec, engine, meta | reason, kind }
//!
//! Implementation mirrors crm::* / backend::* / media_edit::* (slice 5b
//! sidecar pattern):
//!   1. Find pnpm-workspace.yaml (env override or walk up from cwd/exe)
//!   2. Resolve pnpm via cli_agent::resolve_binary (PATH+PATHEXT on Windows)
//!   3. Spawn `pnpm --filter @founder-os/media-providers cli -- <subcommand>`
//!   4. Parse the single-line JSON envelope the CLI emits on stdout
//!
//! The CLI lives at packages/media-providers/src/cli.ts (tsx run by the
//! workspace's "cli" script). Diagnostics go to stderr and are bubbled up in
//! error messages when the JSON parse fails.
//!
//! hf_render serialises the Shot to a temp file under the venture's
//! 10_media/hyperframes/.hf-runs/ directory because passing JSON as a CLI
//! arg trips Node's BatBadBut mitigation on Windows .cmd shims. This mirrors
//! the writeVariablesFile pattern in ensure-project.ts.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::cli_agent;

// ---------------------------------------------------------------------------
// JSON envelopes -- mirror the shapes in packages/media-providers/src/cli.ts.
// `untagged` lets us deserialise either the success or the error shape from
// the same stdout line.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum HfProbeResult {
    Available {
        available: bool,
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
pub enum HfDoctorResult {
    Ok {
        ok: bool,
        raw: serde_json::Value,
    },
    Fail {
        ok: bool,
        reason: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        raw: Option<serde_json::Value>,
    },
    Error {
        error: String,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum HfBootstrapResult {
    Ok {
        ok: bool,
        #[serde(rename = "projectPath")]
        project_path: String,
        #[serde(rename = "freshlyBootstrapped")]
        freshly_bootstrapped: bool,
        #[serde(rename = "installedBlocks")]
        installed_blocks: u32,
        #[serde(rename = "installedComponents")]
        installed_components: u32,
    },
    Fail {
        ok: bool,
        reason: String,
    },
    Error {
        error: String,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum HfRenderResult {
    Ok {
        ok: bool,
        path: String,
        #[serde(rename = "durationSec")]
        duration_sec: f64,
        engine: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        meta: Option<serde_json::Value>,
    },
    Fail {
        ok: bool,
        reason: String,
        /// One of: "lint" | "layout" | "exit" | "spawn" | "other"
        kind: String,
    },
    Error {
        error: String,
    },
}

// ---------------------------------------------------------------------------
// Public commands
// ---------------------------------------------------------------------------

/// Probe the hyperframes binary. Cheap -- shells `hyperframes --version`
/// with a 5s upper bound. Returns `available:true` only when the CLI
/// returns a version string.
#[tauri::command]
pub async fn hf_probe() -> Result<HfProbeResult, String> {
    let stdout = run_cli(&["probe-hf"], Some(Duration::from_secs(15))).await?;
    parse_envelope::<HfProbeResult>(&stdout)
}

/// Run `hyperframes doctor` against the venture's HF project root. Project
/// dir may not exist yet (pre-bootstrap); the CLI gracefully falls back to
/// running doctor without a cwd.
#[tauri::command]
pub async fn hf_doctor(venture_root: String) -> Result<HfDoctorResult, String> {
    let project_root = hyperframes_project_dir(&venture_root);
    let args: Vec<&str> = vec!["doctor-hf", "--project-root", project_root.as_str()];
    let stdout = run_cli(&args, Some(Duration::from_secs(30))).await?;
    parse_envelope::<HfDoctorResult>(&stdout)
}

/// Initialise the venture's HF project under 10_media/hyperframes/ and
/// install the §12 preset (PRESET_CORE_BLOCKS + PRESET_CORE_COMPONENTS).
/// Idempotent: skips `hyperframes init` if index.html already exists, and
/// re-running `add` on installed catalog items is a no-op on the HF side.
/// `freshlyBootstrapped:true` only when init actually ran.
#[tauri::command]
pub async fn hf_bootstrap(venture_root: String) -> Result<HfBootstrapResult, String> {
    let project_root = hyperframes_project_dir(&venture_root);
    let args: Vec<&str> = vec!["bootstrap-hf", "--project-root", project_root.as_str()];
    // Bootstrap can install ~10 catalog items; each `hyperframes add` may
    // do network I/O. Give it 5 minutes total -- the per-CLI-call timeout
    // inside the Node side caps individual adds at 120s.
    let stdout = run_cli(&args, Some(Duration::from_secs(300))).await?;
    parse_envelope::<HfBootstrapResult>(&stdout)
}

/// Render a single shot through HyperFrames. The webview passes the Shot
/// as a JSON string (already validated against ShotSchema on the webview
/// side); we materialise it to a temp file under
/// `<ventureRoot>/10_media/hyperframes/.hf-runs/ipc-<n>.json` so the Node
/// CLI never sees JSON on argv (BatBadBut mitigation on Windows .cmd
/// shims). The file is removed after the CLI returns.
#[tauri::command]
pub async fn hf_render(
    venture_root: String,
    shot_json: String,
    out_dir: String,
) -> Result<HfRenderResult, String> {
    let project_root = hyperframes_project_dir(&venture_root);

    // Stash the shot under .hf-runs/ where ensure-project.ts already
    // writes variables files. Filename includes pid + a monotonic-ish
    // counter so concurrent renders never collide.
    let runs_dir = Path::new(&project_root).join(".hf-runs");
    if let Err(e) = fs::create_dir_all(&runs_dir) {
        return Err(format!("failed to mkdir {}: {}", runs_dir.display(), e));
    }
    let counter = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let shot_path = runs_dir.join(format!("ipc-{}-{}.json", std::process::id(), counter));
    if let Err(e) = fs::write(&shot_path, shot_json) {
        return Err(format!(
            "failed to write shot file {}: {}",
            shot_path.display(),
            e
        ));
    }

    let shot_path_str = shot_path.to_string_lossy().into_owned();
    let args: Vec<&str> = vec![
        "render-hf",
        "--project-root",
        project_root.as_str(),
        "--shot-file",
        shot_path_str.as_str(),
        "--out-dir",
        out_dir.as_str(),
    ];
    // Renders can take a while -- mirror the 5min HF default from spawn.ts.
    let cli_result = run_cli(&args, Some(Duration::from_secs(300))).await;

    // Best-effort cleanup. Failure to delete is non-fatal.
    let _ = fs::remove_file(&shot_path);

    let stdout = cli_result?;
    parse_envelope::<HfRenderResult>(&stdout)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// `<ventureRoot>/10_media/hyperframes` -- mirrors workspace-core's
/// getHyperframesProjectDir() so Node + Rust + WebView all agree on the
/// project layout without an extra IPC round-trip just to compute paths.
fn hyperframes_project_dir(venture_root: &str) -> String {
    let p = Path::new(venture_root).join("10_media").join("hyperframes");
    p.to_string_lossy().into_owned()
}

/// Spawn `pnpm --filter @founder-os/media-providers cli -- <args>` in the
/// workspace root and return stdout. Errors include stderr for diagnosis.
/// Lifted from crm::run_cli and backend::run_cli; behaviour identical.
async fn run_cli(args: &[&str], timeout: Option<Duration>) -> Result<String, String> {
    let workspace_root = find_workspace_root().ok_or_else(|| {
        "could not locate pnpm-workspace.yaml -- set FOUNDER_OS_REPO_ROOT env var \
         or launch from a Founder OS workspace"
            .to_string()
    })?;

    let pnpm_path = cli_agent::resolve_binary("pnpm")
        .or_else(|| cli_agent::resolve_binary("pnpm.cmd"))
        .ok_or_else(|| {
            "pnpm not found on PATH -- install pnpm to use media commands".to_string()
        })?;

    let mut cmd = Command::new(&pnpm_path);
    cmd.arg("--filter")
        .arg("@founder-os/media-providers")
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
                    "media-providers CLI timed out after {}s (args: {:?})",
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
            "media-providers CLI exited with {:?}\nstderr:\n{}\nstdout:\n{}",
            output.status.code(),
            stderr.trim(),
            stdout.trim()
        ));
    }

    Ok(stdout)
}

/// Parse the LAST non-empty stdout line as a JSON envelope. Mirrors
/// crm::parse_envelope -- the CLI's success / error envelopes are
/// emitted as a single trailing line; pnpm + tsx chatter precedes it.
fn parse_envelope<T: serde::de::DeserializeOwned>(stdout: &str) -> Result<T, String> {
    let last = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .ok_or_else(|| "media-providers CLI produced no stdout".to_string())?;
    serde_json::from_str::<T>(last).map_err(|e| {
        format!(
            "failed to parse media-providers CLI envelope: {}\nlast stdout line: {}",
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
