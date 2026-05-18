use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::process::Command;

#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum HandoffPackRunStageResult {
    Ok {
        result: Value,
        counts: Value,
        steps: Value,
        #[serde(rename = "checkpointPath")]
        checkpoint_path: Option<String>,
    },
    Error {
        error: String,
    },
}

#[tauri::command]
pub async fn handoff_pack_run_stage(
    venture_root: String,
    manifest_path: String,
    force: Option<bool>,
) -> Result<HandoffPackRunStageResult, String> {
    let mut args = vec![
        "--filter".to_string(),
        "@founder-os/stage-runners".to_string(),
        "cli".to_string(),
        "handoff-pack-run-stage".to_string(),
        "--venture-root".to_string(),
        venture_root,
        "--manifest".to_string(),
        manifest_path,
    ];
    if force.unwrap_or(false) {
        args.push("--force".to_string());
    }
    let stdout = run_pnpm(args).await?;
    parse_envelope(&stdout)
}

async fn run_pnpm(args: Vec<String>) -> Result<String, String> {
    let workspace_root = workspace_root()?;
    let mut cmd = Command::new(pnpm_bin());
    for arg in args {
        cmd.arg(arg);
    }
    cmd.current_dir(&workspace_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn pnpm: {}", e))?;
    let output = tokio::time::timeout(std::time::Duration::from_secs(300), child.wait_with_output())
        .await
        .map_err(|_| "handoff pack sidecar timed out".to_string())?
        .map_err(|e| format!("pnpm wait failed: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if output.status.success() {
        Ok(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!(
            "pnpm exited with status {}. stderr: {} stdout: {}",
            output.status, stderr, stdout
        ))
    }
}

fn parse_envelope(stdout: &str) -> Result<HandoffPackRunStageResult, String> {
    let last = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .ok_or_else(|| "handoff pack sidecar produced no stdout".to_string())?;
    serde_json::from_str(last).map_err(|err| {
        format!(
            "failed to parse handoff pack sidecar JSON: {}. stdout: {}",
            err, stdout
        )
    })
}

fn workspace_root() -> Result<PathBuf, String> {
    let mut dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    loop {
        if dir.join("pnpm-workspace.yaml").exists() {
            return Ok(dir);
        }
        if !dir.pop() {
            return Err("could not find pnpm-workspace.yaml from CARGO_MANIFEST_DIR".to_string());
        }
    }
}

fn pnpm_bin() -> String {
    if cfg!(windows) {
        "pnpm.cmd".to_string()
    } else {
        "pnpm".to_string()
    }
}
