//! Dream Vault filesystem commands — slice 2 of the Rust IPC arc.
//!
//! Four commands that turn the slice-9 `safeInvoke` stubs in
//! `apps/founder-desktop/src/features/vault/run-vault-import.ts` into
//! real disk operations:
//!
//!   vault_hash_file({ absolutePath }) -> String
//!     Streaming SHA-256 hex. Used as the content-addressing key for
//!     dedupe + the cache-path generator below.
//!
//!   vault_read_file_bytes({ absolutePath }) -> Vec<u8>
//!     Full file bytes. Serialized as a JSON number array by Tauri's
//!     bridge — fine for the renderer's `new Uint8Array(result)` path.
//!     Cost is ~4x of base64 for transit but the import-cache files
//!     are mostly small (chat JSON, single PDFs, single images). The
//!     existing `pdf::pdf_extract_text` uses base64 for input where
//!     payloads can hit multi-MB; output here is symmetric only when
//!     we know the renderer wants a UInt8Array.
//!
//!   vault_stage_file({ absolutePath, workspaceRoot, hash, extension? })
//!     Copy the original file into <workspaceRoot>/_vault/_import-cache/
//!     <hash-prefix>/<hash-rest>.<ext>. Returns the cached relative +
//!     absolute paths so the renderer can hand them to vault_get_job +
//!     vault_read_file_bytes.
//!
//!   vault_save_pasted_blob({ workspaceRoot, text, title? })
//!     Hash the paste text + write into the same import cache. Mirrors
//!     vault_stage_file's envelope so the runner treats paste + file
//!     sources identically downstream.
//!
//! All four commands run synchronously on Tauri's worker thread pool.
//! For multi-GB files the streaming hash uses 64 KiB buffers so we
//! don't blow up the heap.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const CHUNK_SIZE: usize = 64 * 1024;

/// Reply envelope shared by `vault_stage_file` + `vault_save_pasted_blob`.
/// The renderer reads `cachedRelativePath` for `SourceDocument.cachedOriginalPath`,
/// `absolutePath` for the extractor port input, and `contentHash` for
/// dedupe + the SQLite `content_hash` column.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedFile {
    /// Forward-slash workspace-relative path. Slashes are intentional —
    /// the renderer's `resolveCachedPath` joins with `/` and Windows
    /// APIs accept forward slashes everywhere we use them.
    pub cached_relative_path: String,
    /// Platform-native absolute path. On Windows this has backslashes.
    pub absolute_path: String,
    pub content_hash: String,
    pub byte_size: u64,
}

// ────────────────────────────────────────────────────────────────────────────
// Path helpers
// ────────────────────────────────────────────────────────────────────────────

/// Map a sha-256 hex string + optional extension onto the import-cache
/// relative path. Two-char hex prefix becomes the directory bucket —
/// matches the TS-side fallback string in run-vault-import.ts so a
/// future split (TS computes hash, Rust copies) and the bundled
/// stage-file path both arrive at the same place.
fn cache_relative_path(hash: &str, extension: Option<&str>) -> String {
    let (prefix, rest) = if hash.len() > 2 {
        (&hash[..2], &hash[2..])
    } else {
        (hash, "")
    };
    match extension {
        Some(ext) if !ext.is_empty() => {
            format!("_vault/_import-cache/{prefix}/{rest}.{ext}")
        }
        _ => format!("_vault/_import-cache/{prefix}/{rest}"),
    }
}

/// Join workspaceRoot + a workspace-relative path. We trim the
/// trailing separator off the root and the leading separator off the
/// relative path so the result has exactly one separator between them.
fn resolve_absolute(workspace_root: &str, relative: &str) -> PathBuf {
    let root_trimmed = workspace_root.trim_end_matches(['\\', '/']);
    let rel_trimmed = relative.trim_start_matches(['\\', '/']);
    let mut p = PathBuf::from(root_trimmed);
    for segment in rel_trimmed.split(['/', '\\']) {
        if !segment.is_empty() {
            p.push(segment);
        }
    }
    p
}

fn ensure_parent(target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir -p '{}' failed: {e}", parent.display()))?;
    }
    Ok(())
}

// ────────────────────────────────────────────────────────────────────────────
// vault_hash_file
// ────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn vault_hash_file(absolute_path: String) -> Result<String, String> {
    let path = PathBuf::from(&absolute_path);
    let file = fs::File::open(&path)
        .map_err(|e| format!("open '{}' failed: {e}", path.display()))?;
    let mut reader = std::io::BufReader::with_capacity(CHUNK_SIZE, file);
    let mut hasher = Sha256::new();
    let mut buf = [0u8; CHUNK_SIZE];
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("read '{}' failed: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex_encode(&hasher.finalize()))
}

// ────────────────────────────────────────────────────────────────────────────
// vault_read_file_bytes
// ────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn vault_read_file_bytes(absolute_path: String) -> Result<Vec<u8>, String> {
    let path = PathBuf::from(&absolute_path);
    fs::read(&path).map_err(|e| format!("read '{}' failed: {e}", path.display()))
}

// ────────────────────────────────────────────────────────────────────────────
// vault_stage_file
// ────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageFileArgs {
    pub absolute_path: String,
    pub workspace_root: String,
    /// Pre-computed sha-256 from a prior vault_hash_file call. The two
    /// commands are split so the renderer can dedupe by hash before
    /// the copy: if the hash already exists in vault_source_documents
    /// the caller skips staging and reuses the cached row.
    pub hash: String,
    /// File extension without the leading dot. Optional — paste blobs
    /// don't have one.
    pub extension: Option<String>,
}

#[tauri::command]
pub fn vault_stage_file(args: StageFileArgs) -> Result<StagedFile, String> {
    let StageFileArgs {
        absolute_path,
        workspace_root,
        hash,
        extension,
    } = args;
    let relative = cache_relative_path(&hash, extension.as_deref());
    let target = resolve_absolute(&workspace_root, &relative);
    let source = PathBuf::from(&absolute_path);

    if !source.exists() {
        return Err(format!("source file not found: {}", source.display()));
    }
    ensure_parent(&target)?;

    // If the file is already in the cache (same hash + same extension,
    // common case for re-imports), skip the copy. fs::copy on an
    // existing file is overwrite, which is correct but wastes IO.
    let byte_size = if target.exists() {
        fs::metadata(&target)
            .map_err(|e| format!("stat cached file '{}' failed: {e}", target.display()))?
            .len()
    } else {
        fs::copy(&source, &target).map_err(|e| {
            format!(
                "copy '{}' -> '{}' failed: {e}",
                source.display(),
                target.display()
            )
        })?
    };

    Ok(StagedFile {
        cached_relative_path: relative,
        absolute_path: target.to_string_lossy().to_string(),
        content_hash: hash,
        byte_size,
    })
}

// ────────────────────────────────────────────────────────────────────────────
// vault_save_pasted_blob
// ────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePastedBlobArgs {
    pub workspace_root: String,
    pub text: String,
    /// Optional title; not used for the path (the hash is the identity)
    /// but kept on the signature for parity with the TS contract — the
    /// renderer threads it through for logging / future use.
    #[allow(dead_code)]
    pub title: Option<String>,
}

#[tauri::command]
pub fn vault_save_pasted_blob(args: SavePastedBlobArgs) -> Result<StagedFile, String> {
    let SavePastedBlobArgs {
        workspace_root,
        text,
        title: _,
    } = args;

    let bytes = text.as_bytes();
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let hash = hex_encode(&hasher.finalize());

    let relative = cache_relative_path(&hash, Some("txt"));
    let target = resolve_absolute(&workspace_root, &relative);

    ensure_parent(&target)?;
    if !target.exists() {
        let mut f = fs::File::create(&target)
            .map_err(|e| format!("create '{}' failed: {e}", target.display()))?;
        f.write_all(bytes)
            .map_err(|e| format!("write '{}' failed: {e}", target.display()))?;
    }

    Ok(StagedFile {
        cached_relative_path: relative,
        absolute_path: target.to_string_lossy().to_string(),
        content_hash: hash,
        byte_size: bytes.len() as u64,
    })
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}
