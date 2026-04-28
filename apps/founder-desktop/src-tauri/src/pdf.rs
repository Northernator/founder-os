//! PDF text extraction for chat attachments.
//!
//! The WebView side (`lib/chat-attachments.ts`) reads the user's `File` as
//! an ArrayBuffer, base64-encodes it, and calls `pdf_extract_text` over
//! IPC. We decode back to bytes and hand them to the `pdf-extract` crate's
//! in-memory entry point.
//!
//! Why base64, not `Vec<u8>` directly?
//! -----------------------------------
//! Tauri v2's `invoke` serialises through JSON. A 2 MB `Uint8Array`
//! encoded as a JSON number array blows up to ~6 MB of text and parses
//! slowly in the bridge. Base64 adds a fixed ~33% overhead and parses as
//! a plain string — much cheaper end-to-end.
//!
//! Panic safety
//! ------------
//! `pdf-extract` is solid on well-formed input but can still panic on
//! crafted / corrupt PDFs (encrypted streams, malformed xref, etc.). We
//! wrap the call in `catch_unwind` so a bad file returns an Err that the
//! UI can toast, rather than taking the whole Tauri command thread down.
//!
//! Blocking behaviour
//! ------------------
//! Extraction is CPU-bound and synchronous. Tauri v2 runs non-async
//! commands on a worker thread pool, so this doesn't block the WebView
//! or the main loop. We don't bother with `spawn_blocking` — the 2 MB
//! size cap enforced on the TS side keeps worst-case latency under ~1s
//! on a modern machine.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::panic::{catch_unwind, AssertUnwindSafe};

/// Decode a base64 string to bytes, extract text from the PDF, and
/// return it. All errors (decode, extraction, panic) are surfaced as
/// `Err(String)` so the TS caller can render them verbatim.
#[tauri::command]
pub fn pdf_extract_text(base64_bytes: String) -> Result<String, String> {
    let bytes = STANDARD
        .decode(base64_bytes.as_bytes())
        .map_err(|e| format!("pdf: invalid base64 payload — {e}"))?;

    if bytes.is_empty() {
        return Err("pdf: empty file".into());
    }

    // `extract_text_from_mem` takes `&[u8]` and is infallible about panics
    // only in the happy case — wrap to be safe.
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        pdf_extract::extract_text_from_mem(&bytes)
    }));

    match outcome {
        Ok(Ok(text)) => Ok(text),
        Ok(Err(e)) => Err(format!("pdf: extraction failed — {e}")),
        Err(_) => Err("pdf: extraction panicked (file may be encrypted or malformed)".into()),
    }
}
