/**
 * Magic-byte fallback for renamed files (PDFs with no extension, images
 * mis-extension-ed as .txt, etc). Cheap: reads at most the first 32 bytes.
 *
 * Returns null if no signature matches -- the caller falls back to the
 * extension+mime detection from file-type.ts.
 */

import { open } from "node:fs/promises";
import type { SourceType } from "@founder-os/vault-contract";

interface MagicSignature {
  bytes: Buffer;
  offset: number;
  sourceType: SourceType;
  mime: string;
}

const SIGNATURES: MagicSignature[] = [
  {
    bytes: Buffer.from([0x25, 0x50, 0x44, 0x46]), // %PDF
    offset: 0,
    sourceType: "document",
    mime: "application/pdf",
  },
  {
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG
    offset: 0,
    sourceType: "image",
    mime: "image/png",
  },
  {
    bytes: Buffer.from([0xff, 0xd8, 0xff]), // JPEG SOI + APP marker prefix
    offset: 0,
    sourceType: "image",
    mime: "image/jpeg",
  },
  {
    bytes: Buffer.from([0x47, 0x49, 0x46, 0x38]), // GIF8
    offset: 0,
    sourceType: "image",
    mime: "image/gif",
  },
  {
    bytes: Buffer.from([0x52, 0x49, 0x46, 0x46]), // RIFF (webp container)
    offset: 0,
    sourceType: "image",
    mime: "image/webp",
  },
  {
    bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]), // PK\x03\x04 (zip-based: docx, xlsx)
    offset: 0,
    sourceType: "document",
    mime: "application/zip",
  },
];

export interface MagicProbeResult {
  sourceType: SourceType;
  mime: string;
}

export async function probeMagicBytes(absolutePath: string): Promise<MagicProbeResult | null> {
  const fh = await open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(32);
    const { bytesRead } = await fh.read(buffer, 0, 32, 0);
    if (bytesRead < 3) return null;
    for (const sig of SIGNATURES) {
      const end = sig.offset + sig.bytes.length;
      if (bytesRead < end) continue;
      const slice = buffer.subarray(sig.offset, end);
      if (slice.equals(sig.bytes)) {
        return { sourceType: sig.sourceType, mime: sig.mime };
      }
    }
    return null;
  } finally {
    await fh.close();
  }
}
