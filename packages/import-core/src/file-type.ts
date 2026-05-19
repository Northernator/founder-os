/**
 * File-type detection for ingested sources.
 *
 * Strategy:
 *   1. Extension wins for the common cases (pdf/docx/md/png/...). Cheap,
 *      deterministic, runs in the renderer.
 *   2. Mime-type sniff handles the "user dragged a file with no extension".
 *   3. Magic-byte fallback (Node-only, in ./node/magic-bytes.ts) is used by
 *      the Node side when 1 + 2 disagree -- typically renamed PDFs and
 *      images.
 *
 * The pure-TS layer here is intentionally extension/mime only so the
 * renderer can mirror this exact mapping when previewing import staging
 * before the Node side touches disk.
 */

import type { SourceType } from "@founder-os/vault-contract";

export interface FileTypeProbe {
  originalName: string;
  /** Lowercased extension without leading dot. May be empty. */
  fileExtension: string;
  /** Either the OS-reported mime type or undefined. */
  mimeType?: string;
}

export interface FileTypeResult {
  sourceType: SourceType;
  /** Canonical mime guess used when the OS gave us nothing. */
  inferredMimeType?: string;
  /** Heuristic confidence so import-core can decide whether to magic-byte fallback. */
  confidence: "high" | "medium" | "low";
}

const EXT_TO_TYPE: Record<string, { sourceType: SourceType; mime: string }> = {
  pdf: { sourceType: "document", mime: "application/pdf" },
  doc: {
    sourceType: "document",
    mime: "application/msword",
  },
  docx: {
    sourceType: "document",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  rtf: { sourceType: "document", mime: "application/rtf" },
  odt: {
    sourceType: "document",
    mime: "application/vnd.oasis.opendocument.text",
  },
  txt: { sourceType: "document", mime: "text/plain" },
  md: { sourceType: "document", mime: "text/markdown" },
  markdown: { sourceType: "document", mime: "text/markdown" },
  html: { sourceType: "document", mime: "text/html" },
  htm: { sourceType: "document", mime: "text/html" },
  png: { sourceType: "image", mime: "image/png" },
  jpg: { sourceType: "image", mime: "image/jpeg" },
  jpeg: { sourceType: "image", mime: "image/jpeg" },
  gif: { sourceType: "image", mime: "image/gif" },
  webp: { sourceType: "image", mime: "image/webp" },
  bmp: { sourceType: "image", mime: "image/bmp" },
  tif: { sourceType: "image", mime: "image/tiff" },
  tiff: { sourceType: "image", mime: "image/tiff" },
  svg: { sourceType: "image", mime: "image/svg+xml" },
  csv: { sourceType: "spreadsheet", mime: "text/csv" },
  tsv: { sourceType: "spreadsheet", mime: "text/tab-separated-values" },
  xls: { sourceType: "spreadsheet", mime: "application/vnd.ms-excel" },
  xlsx: {
    sourceType: "spreadsheet",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  json: { sourceType: "structured", mime: "application/json" },
  yaml: { sourceType: "structured", mime: "application/yaml" },
  yml: { sourceType: "structured", mime: "application/yaml" },
  ts: { sourceType: "code", mime: "text/typescript" },
  tsx: { sourceType: "code", mime: "text/typescript" },
  js: { sourceType: "code", mime: "application/javascript" },
  jsx: { sourceType: "code", mime: "application/javascript" },
  py: { sourceType: "code", mime: "text/x-python" },
  rs: { sourceType: "code", mime: "text/rust" },
  go: { sourceType: "code", mime: "text/x-go" },
  java: { sourceType: "code", mime: "text/x-java" },
  vtt: { sourceType: "transcript", mime: "text/vtt" },
  srt: { sourceType: "transcript", mime: "application/x-subrip" },
};

/**
 * Filenames the user might have exported from ChatGPT/Claude. These get
 * classified as chat regardless of extension because the chat-importer
 * (slice 4) reads them via its own parser.
 */
const CHAT_FILENAME_PATTERNS: RegExp[] = [
  /^conversations\.json$/i,
  /chat[-_ ]?export.*\.(?:json|md|markdown)$/i,
  /claude[-_ ]?export.*\.(?:json|md|markdown)$/i,
  /chatgpt[-_ ]?export.*\.(?:json|md|markdown)$/i,
];

/** Mimes that override the extension lookup (handles renamed files). */
const MIME_OVERRIDES: Record<string, SourceType> = {
  "application/pdf": "document",
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
  "image/gif": "image",
  "image/tiff": "image",
  "image/bmp": "image",
  "text/csv": "spreadsheet",
  "application/json": "structured",
};

export function detectFileType(probe: FileTypeProbe): FileTypeResult {
  const ext = normaliseExt(probe.fileExtension);
  const lowered = probe.originalName.toLowerCase();
  for (const re of CHAT_FILENAME_PATTERNS) {
    if (re.test(lowered)) {
      return { sourceType: "chat", confidence: "high" };
    }
  }
  const mime = probe.mimeType?.toLowerCase();
  if (mime && MIME_OVERRIDES[mime]) {
    return {
      sourceType: MIME_OVERRIDES[mime] as SourceType,
      inferredMimeType: mime,
      confidence: "high",
    };
  }
  const byExt = ext ? EXT_TO_TYPE[ext] : undefined;
  if (byExt) {
    return {
      sourceType: byExt.sourceType,
      inferredMimeType: byExt.mime,
      confidence: "high",
    };
  }
  if (mime?.startsWith("text/")) {
    return { sourceType: "document", inferredMimeType: mime, confidence: "medium" };
  }
  if (mime?.startsWith("image/")) {
    return { sourceType: "image", inferredMimeType: mime, confidence: "medium" };
  }
  return { sourceType: "other", confidence: "low" };
}

export function extractExtension(originalName: string): string {
  const idx = originalName.lastIndexOf(".");
  if (idx < 0 || idx === originalName.length - 1) return "";
  return normaliseExt(originalName.slice(idx + 1));
}

function normaliseExt(value: string | undefined): string {
  if (!value) return "";
  return value.replace(/^\.+/, "").toLowerCase();
}
