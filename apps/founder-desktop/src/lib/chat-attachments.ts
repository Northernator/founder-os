/**
 * Chat attachment extraction.
 *
 * Takes a browser `File` and returns plain text the assistant can read.
 * Lives outside @founder-os/chat-ui so we don't pull mammoth (~250KB) into
 * every consumer of the chat package.
 *
 * Supported formats
 * -----------------
 * Text-ish (.md, .txt, .json)  → FileReader.readAsText
 * .docx                        → mammoth.extractRawText (browser build)
 * .pdf                         → Rust `pdf_extract_text` command backed by
 *                                the `pdf-extract` crate. Bytes are sent
 *                                over IPC as base64 (compact + cheap
 *                                JSON-parse vs a `Uint8Array` spread).
 *                                On empty-text fallthrough (image-only
 *                                scans), kicks over to OCR below.
 *
 * OCR fallback (scanned PDFs)
 * ---------------------------
 * When pdf-extract returns empty text, we assume the PDF is image-only
 * (scanned). The WebView-side fallback uses **pdfjs-dist** to raster each
 * page to a canvas, then **tesseract.js** to OCR the canvas. Both libs are
 * **dynamic-imported** so the steady-state bundle (text/docx/text-extracted
 * PDFs) never pays the ~17MB cost of tesseract's WASM + eng.traineddata.
 *
 * OCR trade-offs:
 *  - First run downloads ~15MB of WASM + language data from jsDelivr
 *    (Tauri's CSP is null, so cross-origin fetch is fine). Subsequent runs
 *    hit the browser HTTP cache.
 *  - Per-page OCR typically 2-5s on a modern laptop CPU. We cap at
 *    MAX_OCR_PAGES pages to bound worst-case wait time; the user gets a
 *    truncation warning if they hit it.
 *  - One info toast fires at OCR start so the chat UI's spinner isn't a
 *    silent mystery for 10-30s while the WASM loads + pages churn.
 *
 * Policy calls
 * ------------
 *  - Size cap: 2 MB per file. Above that we refuse rather than stuff half
 *    a megabyte of token-expensive prose into every future system prompt.
 *  - Unknown extensions fall through to `readAsText` with a best-effort
 *    "might be garbage" outcome. The user sees a warn toast if the result
 *    is clearly binary, but we don't second-guess them.
 */

import { invoke } from "@tauri-apps/api/core";
import { pushToast } from "./toasts.js";

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * Page cap for OCR. Scanned PDFs are bandwidth-bounded by MAX_BYTES to a
 * handful of pages at typical 150dpi, but we still bound the upper end so
 * a user dumping a weird 30-page image-only PDF doesn't freeze the UI for
 * 2 minutes. Overflow is truncated with a toast warning.
 */
const MAX_OCR_PAGES = 10;

/** Rasterisation DPI for OCR. 2.0x CSS-pixel scale ≈ 144dpi — enough for
 * tesseract to read body text reliably without ballooning memory. */
const OCR_RASTER_SCALE = 2.0;

export type ExtractResult = { kind: "ok"; text: string } | { kind: "error"; error: string };

/** Public entry point. Picks the right extractor by extension + MIME. */
export async function extractAttachment(file: File): Promise<ExtractResult> {
  if (file.size > MAX_BYTES) {
    return {
      kind: "error",
      error: `File too large (${Math.round(file.size / 1024)} KB — max 2048 KB)`,
    };
  }

  const ext = extensionOf(file.name);

  if (ext === "pdf" || file.type === "application/pdf") {
    return extractPdf(file);
  }

  if (ext === "docx" || isDocxMime(file.type)) {
    return extractDocx(file);
  }

  if (ext === "md" || ext === "txt" || ext === "json") {
    return extractText(file);
  }

  // Unknown extension — optimistic readAsText. Works for any reasonable
  // text file the user chose with intent; a binary blob here will read as
  // mojibake which we'll partially detect below.
  const result = await extractText(file);
  if (result.kind === "ok" && looksBinary(result.text)) {
    return {
      kind: "error",
      error: `Couldn't read "${file.name}" as text. Try .md, .txt, .json or .docx.`,
    };
  }
  return result;
}

async function extractText(file: File): Promise<ExtractResult> {
  try {
    const text = await file.text();
    return { kind: "ok", text };
  } catch (err) {
    return { kind: "error", error: errMessage(err) };
  }
}

async function extractDocx(file: File): Promise<ExtractResult> {
  try {
    // Dynamic import keeps mammoth out of the initial bundle so the app
    // still starts quickly when no-one's attaching docx files. The browser
    // build reads an ArrayBuffer, not a File object.
    const { default: mammoth } = await import("mammoth/mammoth.browser.js");
    const buf = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer: buf });
    const text = (result?.value ?? "").trim();
    if (!text) {
      return {
        kind: "error",
        error: "docx extracted to empty text — is the file a real Word doc?",
      };
    }
    return { kind: "ok", text };
  } catch (err) {
    return {
      kind: "error",
      error: `Couldn't parse .docx — ${errMessage(err)}`,
    };
  }
}

async function extractPdf(file: File): Promise<ExtractResult> {
  let buf: ArrayBuffer;
  try {
    buf = await file.arrayBuffer();
  } catch (err) {
    return { kind: "error", error: `Couldn't read PDF — ${errMessage(err)}` };
  }

  // Try the cheap path first: pdf-extract on the Rust side reads the PDF's
  // embedded text objects. Works on any PDF generated from Word, LaTeX,
  // browser-print, etc. Fails with empty text on image-only scans.
  try {
    const text = await invoke<string>("pdf_extract_text", {
      base64Bytes: arrayBufferToBase64(buf),
    });
    const trimmed = (text ?? "").trim();
    if (trimmed) {
      return { kind: "ok", text: trimmed };
    }
  } catch (err) {
    // Rust extraction crashed (malformed / encrypted / pdf-extract panic).
    // Still worth trying the OCR fallback — a corrupt text layer doesn't
    // preclude a readable image layer.
    console.warn("[chat-attachments] pdf_extract_text failed, falling to OCR", err);
  }

  // Fallback: raster + OCR. Fires a toast first because the user is about
  // to wait 10-30s for first-run WASM download + per-page OCR.
  return extractPdfOcr(new Uint8Array(buf), file.name);
}

/**
 * OCR fallback for image-only PDFs.
 *
 * Sequence per PDF:
 *  1. Toast "Running OCR on N pages…" so the wait isn't mysterious.
 *  2. Dynamic-import pdfjs-dist (+ worker) and tesseract.js. These are big;
 *     keeping them behind dynamic import means the idle-app bundle never
 *     pays.
 *  3. `getDocument(bytes)` → iterate pages up to MAX_OCR_PAGES, render each
 *     to an OffscreenCanvas-or-HTMLCanvas at OCR_RASTER_SCALE.
 *  4. Reuse a single Tesseract worker across pages (worker startup is the
 *     expensive bit). `terminate()` in a finally block.
 *  5. Join page texts with "--- Page N ---" separators so the assistant can
 *     reason about page-level context.
 *
 * Failure modes surface as `{ kind: "error" }` so the caller's toast path
 * fires — we don't silently swallow.
 */
async function extractPdfOcr(bytes: Uint8Array, fileName: string): Promise<ExtractResult> {
  // 1. Load pdfjs-dist and wire its worker. The `?url` import is a Vite
  // primitive — it bundles the worker as a static asset and returns a URL
  // the main thread can hand to GlobalWorkerOptions.
  let pdfjsLib: typeof import("pdfjs-dist");
  try {
    pdfjsLib = await import("pdfjs-dist");
    // @ts-expect-error — `?url` import is Vite-specific, no type decl.
    const workerModule = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerModule.default;
  } catch (err) {
    return {
      kind: "error",
      error: `OCR unavailable — couldn't load PDF renderer: ${errMessage(err)}`,
    };
  }

  // Open the PDF and discover page count before committing to OCR.
  let pdf: Awaited<ReturnType<typeof pdfjsLib.getDocument>["promise"]>;
  try {
    // pdfjs mutates the input buffer during parse, so hand it a copy.
    const task = pdfjsLib.getDocument({ data: bytes.slice() });
    pdf = await task.promise;
  } catch (err) {
    return {
      kind: "error",
      error: `PDF couldn't be opened for OCR — ${errMessage(err)}`,
    };
  }

  const pageCount = pdf.numPages;
  const pagesToRead = Math.min(pageCount, MAX_OCR_PAGES);
  const truncated = pageCount > MAX_OCR_PAGES;

  pushToast({
    kind: "info",
    message: `Running OCR on "${fileName}"`,
    detail: truncated
      ? `${pagesToRead} of ${pageCount} pages (first run downloads ~15MB)`
      : `${pagesToRead} page${pagesToRead === 1 ? "" : "s"} (first run downloads ~15MB)`,
    ttlMs: 8000,
  });

  // 2. Spin up the Tesseract worker once, reuse across pages. v5 API:
  // createWorker returns a worker already loaded with the language model.
  let Tesseract: typeof import("tesseract.js");
  try {
    Tesseract = await import("tesseract.js");
  } catch (err) {
    try {
      await pdf.destroy();
    } catch {
      /* ignore */
    }
    return {
      kind: "error",
      error: `OCR unavailable — couldn't load tesseract.js: ${errMessage(err)}`,
    };
  }

  const worker = await Tesseract.createWorker("eng");
  const pageTexts: string[] = [];
  const pageFailures: string[] = [];

  try {
    for (let i = 1; i <= pagesToRead; i++) {
      try {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: OCR_RASTER_SCALE });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("2d canvas context unavailable");
        await page.render({ canvasContext: ctx, viewport }).promise;

        const {
          data: { text },
        } = await worker.recognize(canvas);
        const cleaned = (text ?? "").trim();
        if (cleaned) {
          pageTexts.push(`--- Page ${i} ---\n${cleaned}`);
        }

        // Release per-page resources promptly — otherwise pdfjs holds the
        // full rendered page cache for every page we've touched.
        page.cleanup();
      } catch (err) {
        pageFailures.push(`page ${i}: ${errMessage(err)}`);
      }
    }
  } finally {
    // Terminate worker + pdf handle regardless of success. Worker teardown
    // is synchronous-ish and not worth awaiting on a success path, but the
    // promise makes the errors visible in console if something breaks.
    try {
      await worker.terminate();
    } catch {
      /* ignore */
    }
    try {
      await pdf.destroy();
    } catch {
      /* ignore */
    }
  }

  const combined = pageTexts.join("\n\n").trim();
  if (!combined) {
    const detail = pageFailures.length
      ? `failures: ${pageFailures.join("; ")}`
      : "pages produced no text — may be blank or encrypted";
    return {
      kind: "error",
      error: `OCR produced no text — ${detail}`,
    };
  }

  // Header tells the assistant this came from OCR (so it can treat minor
  // transcription errors as plausible) and flags truncation.
  const headerLines: string[] = [`[OCR of "${fileName}"]`];
  if (truncated) {
    headerLines.push(`⚠ Only the first ${MAX_OCR_PAGES} of ${pageCount} pages were OCR'd.`);
  }
  if (pageFailures.length) {
    headerLines.push(`⚠ ${pageFailures.length} page(s) failed: ${pageFailures.join("; ")}`);
  }
  const header = headerLines.join("\n");

  pushToast({
    kind: "success",
    message: `OCR complete — "${fileName}"`,
    detail: `Extracted ${combined.length} chars from ${pagesToRead} page${pagesToRead === 1 ? "" : "s"}`,
    ttlMs: 4000,
  });

  return { kind: "ok", text: `${header}\n\n${combined}` };
}

/**
 * Convert an ArrayBuffer to base64 in 32KB chunks.
 *
 * `btoa(String.fromCharCode.apply(null, bytes))` blows the call-stack
 * argument limit on ~100KB+ inputs in most engines. Chunked build-up of
 * the binary string avoids that while still being ~10x faster than a
 * per-byte loop. We don't reach for `FileReader.readAsDataURL` because
 * that returns a data: URL we'd have to strip the prefix off anyway.
 */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000; // 32KB — well under the call-stack limit
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    // `fromCharCode.apply` with a typed-array subarray works in every
    // browser engine Tauri supports.
    binary += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return btoa(binary);
}

function extensionOf(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx === -1 || idx === name.length - 1) return "";
  return name.slice(idx + 1).toLowerCase();
}

function isDocxMime(mime: string): boolean {
  return (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/msword"
  );
}

/**
 * Quick-and-dirty binary sniff. If more than ~5% of the first 4KB are
 * non-printable control bytes we treat it as binary. Good enough to catch
 * a stray PDF/zip/image that slipped past the accept filter; not a real
 * charset detector.
 */
function looksBinary(text: string): boolean {
  const sample = text.slice(0, 4096);
  if (sample.length === 0) return false;
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    // Allow tab (9), LF (10), CR (13), everything printable ≥ 32.
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32) bad++;
    else if (code === 0xfffd) bad++; // replacement char
  }
  return bad / sample.length > 0.05;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Helper for the dashboard: given a list of ready attachments + their
 * extracted text, produce a user-message prefix block the assistant can
 * quote against. Returns "" when there are no attachments.
 *
 * Format intentionally verbose — each file fenced with its name so the
 * assistant can reference individual pastes. Kept in one place so the
 * prompt shape evolves consistently.
 */
export function buildAttachmentBlock(parts: Array<{ name: string; text: string }>): string {
  if (parts.length === 0) return "";
  const lines: string[] = [];
  lines.push(`I've attached ${parts.length} file${parts.length === 1 ? "" : "s"}:`);
  for (const p of parts) {
    lines.push("");
    lines.push(`--- BEGIN ATTACHMENT: ${p.name} ---`);
    lines.push(p.text);
    lines.push(`--- END ATTACHMENT: ${p.name} ---`);
  }
  return lines.join("\n");
}
