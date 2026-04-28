//! Brand-pack ZIP exporter.
//!
//! One Tauri command — `brand_zip_pack` — that walks a venture's
//! `03_brand/exports/` directory and produces `brand-pack.zip` in the
//! same `03_brand/` folder. The frontend's "Download brand pack"
//! button calls this and then reveals the ZIP in the OS file manager
//! so the user can drag it out.
//!
//! Implementation notes:
//!   * We use the `zip` crate with `deflate` compression only. `bzip2`
//!     and `zstd` aren't supported by Windows Explorer / macOS Finder
//!     / most consumer tools, so adding them would just produce files
//!     users couldn't open. Disabled via Cargo features.
//!   * `walkdir` handles the recursive traversal with symlink
//!     following disabled (default) — we only want the real files the
//!     generator wrote, not whatever a misconfigured venture dir
//!     might link out to.
//!   * The output lands at `<venture>/03_brand/brand-pack.zip` rather
//!     than inside `exports/` so consecutive runs don't end up zipping
//!     a previous ZIP (which would work but would look weird in the
//!     archive listing).

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;
use zip::write::{FileOptions, ZipWriter};
use zip::CompressionMethod;

use super::expand_tilde;

/// Zip `<venture>/03_brand/exports/` into `<venture>/03_brand/brand-pack.zip`.
///
/// Returns the absolute path to the produced ZIP on success. Errors
/// propagate as the command's `Err(String)` — the TS side renders them
/// inline in the brand tab.
///
/// Idempotent: an existing `brand-pack.zip` is overwritten. The
/// exports dir must exist and be non-empty; otherwise we return a
/// clear error rather than producing an empty archive (clicking the
/// button before generating any assets is a user error worth
/// surfacing explicitly).
#[tauri::command]
pub fn brand_zip_pack(venture_path: String) -> Result<String, String> {
    let venture = expand_tilde(&venture_path);
    let root = Path::new(&venture);
    if !root.exists() {
        return Err(format!("venture path does not exist: {}", root.display()));
    }

    let exports_dir = root.join("03_brand").join("exports");
    if !exports_dir.exists() {
        return Err(format!(
            "no brand-pack exports at {} — generate the pack first",
            exports_dir.display()
        ));
    }

    let zip_path = root.join("03_brand").join("brand-pack.zip");
    // Make sure the parent dir exists (it should — `03_brand/` is
    // created by every upstream step — but cheap to guard against a
    // user who manually deleted the folder between runs).
    if let Some(parent) = zip_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            format!("failed to create {}: {e}", parent.display())
        })?;
    }

    let zip_file = File::create(&zip_path)
        .map_err(|e| format!("failed to create {}: {e}", zip_path.display()))?;
    let mut writer = ZipWriter::new(zip_file);

    // Deflate gives the best compatibility / ratio trade-off for text
    // assets (SVG / HTML / MD). The tiny logo PNGs we write are
    // already compressed — deflate on them is effectively store, so
    // the ratio loss is moot.
    let options = FileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);

    let mut file_count = 0usize;
    let mut total_bytes = 0u64;

    for entry in WalkDir::new(&exports_dir)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        // Skip the directory entries themselves — zip crate handles
        // directories as separate entries and we don't need them for
        // viewer compatibility (every major tool recreates dirs from
        // file paths).
        if !path.is_file() {
            continue;
        }
        // Compute the archive-internal name relative to the venture
        // root so the ZIP preserves `03_brand/exports/logo/logo.svg`
        // style paths — unzipping into any directory reconstructs the
        // same tree.
        let name = path
            .strip_prefix(root)
            .map_err(|e| format!("strip_prefix failed: {e}"))?
            .to_string_lossy()
            // Normalize backslashes to forward slashes for cross-platform
            // portability inside the zip. ZIP spec is tolerant of both
            // but macOS / Linux readers prefer `/`.
            .replace('\\', "/");

        writer
            .start_file(&name, options)
            .map_err(|e| format!("zip start_file({name}): {e}"))?;
        let mut f = File::open(path)
            .map_err(|e| format!("open {}: {e}", path.display()))?;
        let mut buf = Vec::with_capacity(8192);
        f.read_to_end(&mut buf)
            .map_err(|e| format!("read {}: {e}", path.display()))?;
        writer
            .write_all(&buf)
            .map_err(|e| format!("write {name}: {e}"))?;
        file_count += 1;
        total_bytes += buf.len() as u64;
    }

    if file_count == 0 {
        // Delete the empty zip we just started so a stale zero-byte
        // file doesn't sit on disk confusing the user.
        let _ = std::fs::remove_file(&zip_path);
        return Err(format!(
            "no files under {} — generate the pack first",
            exports_dir.display()
        ));
    }

    writer
        .finish()
        .map_err(|e| format!("zip finish: {e}"))?;

    // Sanity: confirm the file exists and is non-empty before handing
    // the path back. Catches the pathological case of finish()
    // succeeding but the file being removed by something concurrent.
    let metadata = std::fs::metadata(&zip_path)
        .map_err(|e| format!("stat {}: {e}", zip_path.display()))?;
    if metadata.len() == 0 {
        return Err(format!(
            "zip produced but empty: {}",
            zip_path.display()
        ));
    }

    // Return the absolute path so the frontend can invoke `open_path`
    // on it directly without re-resolving. Also log a short summary
    // line for the dev console — cheap traceability when a user
    // reports a bad pack.
    log_summary(&zip_path, file_count, total_bytes, metadata.len());
    Ok(zip_path.to_string_lossy().to_string())
}

fn log_summary(path: &PathBuf, file_count: usize, pre_bytes: u64, zip_bytes: u64) {
    let ratio = if pre_bytes > 0 {
        100.0 * (zip_bytes as f64) / (pre_bytes as f64)
    } else {
        0.0
    };
    println!(
        "[brand_pack] wrote {} ({file_count} files, {pre_bytes} → {zip_bytes} bytes, {ratio:.0}%)",
        path.display()
    );
}
