//! Tauri command: generate_sales_report
//!
//! Spawns `pnpm --filter @founder-os/sales-agents cli report` to render a
//! PDF from an existing memory.json. Replaces the SalesTab "Copy CLI"
//! workaround. One-shot subprocess (not streaming) -- the report command
//! is a blocking ~1s pdfkit render, no need for line-by-line stdout.
//!
//! Reuses cli_agent::resolve_binary for PATH+PATHEXT walking on Windows
//! (npm-installed pnpm.cmd shim is the same gotcha as claude.cmd which
//! cli_agent already solves).
//!
//! Workspace root resolution:
//!  1. FOUNDER_OS_REPO_ROOT env var (explicit override)
//!  2. Walk up from current exe dir looking for pnpm-workspace.yaml
//!  3. Walk up from cwd looking for pnpm-workspace.yaml (dev fallback)
//!
//! Output PDF path is deterministic: same dir as memory.json, named
//! "report.pdf". The CLI itself writes there; we return the predicted
//! path on success and let the caller verify existence.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command;

use crate::cli_agent;

#[tauri::command]
pub async fn generate_sales_report(
    memory_path: String,
    prospect_url: String,
) -> Result<String, String> {
    let workspace_root = find_workspace_root().ok_or_else(|| {
        "could not locate pnpm-workspace.yaml -- set FOUNDER_OS_REPO_ROOT env var \
         or run from a Founder OS workspace"
            .to_string()
    })?;

    let pnpm_path = cli_agent::resolve_binary("pnpm")
        .or_else(|| cli_agent::resolve_binary("pnpm.cmd"))
        .ok_or_else(|| {
            "pnpm not found on PATH -- install pnpm to use in-app PDF generation".to_string()
        })?;

    let output = Command::new(&pnpm_path)
        .arg("--filter")
        .arg("@founder-os/sales-agents")
        .arg("cli")
        .arg("--")
        .arg("report")
        .arg(&memory_path)
        .arg("--url")
        .arg(&prospect_url)
        .current_dir(&workspace_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("failed to spawn pnpm: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "pnpm exited with {:?}\nstderr:\n{}\nstdout:\n{}",
            output.status.code(),
            stderr.trim(),
            stdout.trim()
        ));
    }

    Ok(predict_pdf_path(&memory_path))
}

fn predict_pdf_path(memory_path: &str) -> String {
    if let Some(stripped) = memory_path.strip_suffix("memory.json") {
        format!("{}report.pdf", stripped)
    } else {
        let p = Path::new(memory_path);
        let dir = p.parent().unwrap_or_else(|| Path::new("."));
        dir.join("report.pdf").to_string_lossy().into_owned()
    }
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
