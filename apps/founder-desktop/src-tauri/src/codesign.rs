//! Tauri commands for the CoDesign launcher -- slice 2 of the dual-handoff
//! launcher arc.
//!
//! Two commands bridge the WebView to the @founder-os/handoff-providers
//! Node sidecar. The WebView CAN'T import the Node entry directly (Vite
//! externalises node:child_process + node:fs, the renderer crashes on
//! access -- same blank-screen failure mode the media-providers PM-split
//! memory documents), so every Node-only operation funnels through these
//! commands.
//!
//! Surface:
//!  * `codesign_probe(binary?)` -> { engine, available, path?, version?, reason? }
//!  * `codesign_spawn(binary?)` -> { engine, spawned, pid?, path?, error? }
//!
//! Both shapes are the HandoffProbeResult / HandoffSpawnResult zod schemas
//! from packages/handoff-providers/src/types.ts. The CLI emits them as a
//! single JSON line on stdout; we walk stdout lines from the end to
//! deterministically grab the envelope (tsx + pnpm noise sits in earlier
//! lines).
//!
//! Implementation mirrors crm.rs (slice 5b of the CRM arc):
//!  1. Find pnpm-workspace.yaml (env override or walk up from cwd/exe)
//!  2. Resolve pnpm via cli_agent::resolve_binary (PATH+PATHEXT on Windows)
//!  3. Spawn `pnpm --filter @founder-os/handoff-providers cli -- <subcommand>`
//!  4. Parse the single-line JSON envelope the CLI emits on stdout
//!
//! The CLI lives at packages/handoff-providers/src/cli.ts (tsx run by the
//! workspace's "cli" script).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::cli_agent;

// ---------------------------------------------------------------------------
// JSON envelopes -- match the HandoffProbeResult / HandoffSpawnResult zod
// schemas in packages/handoff-providers/src/types.ts. `untagged` lets us
// deserialise either the launcher's own envelope or the cli.ts
// main().catch fallback envelope ({error: string}) from the same stdout
// line.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum CodesignProbeResult {
    Ok {
        engine: String,
        available: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    Error {
        error: String,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum CodesignSpawnResult {
    Ok {
        engine: String,
        spawned: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        pid: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Error {
        error: String,
    },
}

// ---------------------------------------------------------------------------
// Public commands
// ---------------------------------------------------------------------------

/// Probe whether Open CoDesign is launchable. Cheap (no subprocess spawn
/// on CoDesign itself) -- the CLI does fs.stat over candidate install
/// dirs and a PATH lookup. Returns the launcher's full HandoffProbeResult
/// envelope so the WebView can render the same pill state across the
/// desktop and any future cowork surface.
#[tauri::command]
pub async fn codesign_probe(binary: Option<String>) -> Result<CodesignProbeResult, String> {
    let mut args: Vec<&str> = vec!["probe"];
    if let Some(ref b) = binary {
        args.push("--binary");
        args.push(b.as_str());
    }
    let stdout = run_cli(&args, None).await?;
    parse_envelope::<CodesignProbeResult>(&stdout)
}

/// Spawn Open CoDesign detached. Returns once the child has a PID; the
/// launcher window lives on past the resolution. The renderer pre-loads
/// the OS clipboard with the prompt before calling this -- CoDesign has
/// no documented argv / URL scheme so spawn-cold-and-paste is the only
/// injection path available today (see codesign_launcher_slice_1 memory
/// for the full path comparison vs. 2b/2c).
#[tauri::command]
pub async fn codesign_spawn(binary: Option<String>) -> Result<CodesignSpawnResult, String> {
    let mut args: Vec<&str> = vec!["spawn"];
    if let Some(ref b) = binary {
        args.push("--binary");
        args.push(b.as_str());
    }
    // Spawn returns once child PID is allocated -- still give it a small
    // budget for tsx startup + the launcher's own probe round trip.
    let stdout = run_cli(&args, Some(Duration::from_secs(30))).await?;
    parse_envelope::<CodesignSpawnResult>(&stdout)
}

// ---------------------------------------------------------------------------
// Helpers (mirrored from crm.rs -- could be hoisted to cli_agent.rs in a
// follow-up if a third caller shows up).
// ---------------------------------------------------------------------------

async fn run_cli(args: &[&str], timeout: Option<Duration>) -> Result<String, String> {
    let workspace_root = find_workspace_root().ok_or_else(|| {
        "could not locate pnpm-workspace.yaml -- set FOUNDER_OS_REPO_ROOT env var \
         or launch from a Founder OS workspace"
            .to_string()
    })?;

    let pnpm_path = cli_agent::resolve_binary("pnpm")
        .or_else(|| cli_agent::resolve_binary("pnpm.cmd"))
        .ok_or_else(|| {
            "pnpm not found on PATH -- install pnpm to use CoDesign launcher commands".to_string()
        })?;

    let mut cmd = Command::new(&pnpm_path);
    cmd.arg("--filter")
        .arg("@founder-os/handoff-providers")
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
                    "handoff-providers CLI timed out after {}s (args: {:?})",
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

    // probe + spawn both exit with code 1 on "not available" / "spawn
    // failed" but still emit a well-formed envelope on stdout. We don't
    // require success() here -- the parser figures out the shape.
    // BUT: if there's no stdout at all (e.g. tsx crashed), surface the
    // stderr so the WebView can show something useful.
    if stdout.trim().is_empty() {
        return Err(format!(
            "handoff-providers CLI exited with {:?} and produced no stdout\nstderr:\n{}",
            output.status.code(),
            stderr.trim()
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
        .ok_or_else(|| "handoff-providers CLI produced no stdout".to_string())?;
    serde_json::from_str::<T>(last).map_err(|e| {
        format!(
            "failed to parse handoff-providers CLI envelope: {}\nlast stdout line: {}",
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
