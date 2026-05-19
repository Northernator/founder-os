//! Dream Vault document extraction commands — slice 3 of the Rust IPC arc.
//!
//! Two commands:
//!
//!   vault_extract_pdf({ absolutePath }) -> { markdown, pageCount }
//!     Pure Rust via the `pdf-extract` crate (already a dep for the
//!     chat-attachments path in `pdf.rs`). Runs synchronously on
//!     Tauri's worker thread pool. Page count is approximated by
//!     counting form-feed characters that pdf-extract injects between
//!     pages — not exact for every PDF, but informational only.
//!     Wrapped in catch_unwind because pdf-extract can panic on
//!     malformed input.
//!
//!   vault_extract_docx({ absolutePath }) -> { markdown, warnings[] }
//!     Spawns the `@founder-os/document-extractor` Node sidecar:
//!       pnpm --filter @founder-os/document-extractor cli -- extract-docx --abs <path>
//!     The CLI emits a single-line JSON envelope on stdout
//!     (`{ markdown, warnings }` or `{ error }`). Pattern matches
//!     backend.rs slice 5b — that's the canonical pnpm-CLI sidecar
//!     precedent in this crate, so the same workspace-root walk +
//!     pnpm-resolve helpers apply here.
//!
//! Why DOCX takes the sidecar route + PDF doesn't: the Rust ecosystem
//! has a mature pure-Rust PDF text crate (`pdf-extract`) but no
//! comparable docx-to-markdown crate, and `mammoth` is a long-standing
//! npm package with field-tested DOCX handling. The ~200 ms pnpm-spawn
//! cost is worth it for the maturity gap.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::cli_agent;

// ────────────────────────────────────────────────────────────────────────────
// Wire types — camelCase serde for direct ingestion by the TS extractor
// ports in run-vault-import.ts (lines around documentPort).
// ────────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfExtraction {
    pub markdown: String,
    pub page_count: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxExtraction {
    pub markdown: String,
    pub warnings: Vec<String>,
}

// ────────────────────────────────────────────────────────────────────────────
// vault_extract_pdf
// ────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn vault_extract_pdf(absolute_path: String) -> Result<PdfExtraction, String> {
    let path = PathBuf::from(&absolute_path);
    let bytes = std::fs::read(&path)
        .map_err(|e| format!("read '{}' failed: {e}", path.display()))?;
    if bytes.is_empty() {
        return Err(format!("pdf: empty file: {}", path.display()));
    }
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        pdf_extract::extract_text_from_mem(&bytes)
    }));
    let markdown = match outcome {
        Ok(Ok(text)) => text,
        Ok(Err(e)) => return Err(format!("pdf extraction failed: {e}")),
        Err(_) => {
            return Err(
                "pdf extraction panicked (file may be encrypted or malformed)".to_string(),
            );
        }
    };
    // pdf-extract injects a form-feed (\x0c) between pages. Page count
    // = form-feed count + 1 for a non-empty extraction; 0 for empty
    // (which the TS-side maps to extractionMethod="scanned_pdf_needs_ocr").
    let page_count = if markdown.is_empty() {
        0
    } else {
        u32::try_from(markdown.matches('\u{c}').count()).unwrap_or(u32::MAX) + 1
    };
    Ok(PdfExtraction { markdown, page_count })
}

// ────────────────────────────────────────────────────────────────────────────
// vault_extract_docx — Node sidecar
// ────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(untagged)]
enum DocxEnvelope {
    Ok { markdown: String, warnings: Vec<String> },
    Err { error: String },
}

#[tauri::command]
pub async fn vault_extract_docx(absolute_path: String) -> Result<DocxExtraction, String> {
    let stdout = run_extractor_cli(
        &["extract-docx", "--abs", &absolute_path],
        Some(Duration::from_secs(60)),
    )
    .await?;
    let last = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .ok_or_else(|| "document-extractor CLI produced no stdout".to_string())?;
    let envelope = serde_json::from_str::<DocxEnvelope>(last).map_err(|e| {
        format!(
            "failed to parse document-extractor envelope: {e}\nlast stdout line: {last}"
        )
    })?;
    match envelope {
        DocxEnvelope::Ok { markdown, warnings } => Ok(DocxExtraction { markdown, warnings }),
        DocxEnvelope::Err { error } => Err(format!("docx extraction failed: {error}")),
    }
}

// ────────────────────────────────────────────────────────────────────────────
// pnpm spawn helper — duplicate of backend.rs's run_cli with a
// different --filter target. Kept private to this module so each
// sidecar's command shape stays explicit at its call site.
// ────────────────────────────────────────────────────────────────────────────

async fn run_extractor_cli(args: &[&str], timeout: Option<Duration>) -> Result<String, String> {
    let workspace_root = find_workspace_root().ok_or_else(|| {
        "could not locate pnpm-workspace.yaml -- set FOUNDER_OS_REPO_ROOT env var \
         or launch from a Founder OS workspace"
            .to_string()
    })?;

    let pnpm_path = cli_agent::resolve_binary("pnpm")
        .or_else(|| cli_agent::resolve_binary("pnpm.cmd"))
        .ok_or_else(|| {
            "pnpm not found on PATH -- install pnpm to use the document-extractor sidecar"
                .to_string()
        })?;

    let mut cmd = Command::new(&pnpm_path);
    cmd.arg("--filter")
        .arg("@founder-os/document-extractor")
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
        .map_err(|e| format!("failed to spawn pnpm: {e}"))?;

    let output = if let Some(d) = timeout {
        match tokio::time::timeout(d, child.wait_with_output()).await {
            Ok(result) => result.map_err(|e| format!("pnpm wait failed: {e}"))?,
            Err(_) => {
                return Err(format!(
                    "document-extractor CLI timed out after {}s (args: {:?})",
                    d.as_secs(),
                    args
                ));
            }
        }
    } else {
        child
            .wait_with_output()
            .await
            .map_err(|e| format!("pnpm wait failed: {e}"))?
    };

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    if !output.status.success() {
        return Err(format!(
            "document-extractor CLI exited with {:?}\nstderr:\n{}\nstdout:\n{}",
            output.status.code(),
            stderr.trim(),
            stdout.trim()
        ));
    }
    Ok(stdout)
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
