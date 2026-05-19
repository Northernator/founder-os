/**
 * Tiny pure-TS image header reader. Returns pixel format + (where it can)
 * width and height. Reading dimensions inline avoids a sharp / image-size
 * dep -- the spec calls for a "thin wrapper" and the headers we care
 * about are small fixed fields.
 *
 * Supported: PNG, JPEG (SOF0/SOF2), GIF, WebP (VP8/VP8L/VP8X), BMP, TIFF
 * (just format detection), SVG (just format detection).
 */

import type { ImagePixelFormat } from "./types";

export interface ImageHeader {
  pixelFormat: ImagePixelFormat;
  width?: number;
  height?: number;
}

export function readImageHeader(buffer: Uint8Array): ImageHeader {
  if (buffer.length < 4) return { pixelFormat: "unknown" };

  // PNG: \x89PNG... + IHDR at offset 16.
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    if (buffer.length < 24) return { pixelFormat: "png" };
    return {
      pixelFormat: "png",
      width: be32(buffer, 16),
      height: be32(buffer, 20),
    };
  }

  // JPEG: \xff\xd8\xff
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { pixelFormat: "jpeg", ...readJpegDimensions(buffer) };
  }

  // GIF: GIF87a / GIF89a -- width/height are little-endian at offsets 6/8.
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    if (buffer.length < 10) return { pixelFormat: "gif" };
    return {
      pixelFormat: "gif",
      width: le16(buffer, 6),
      height: le16(buffer, 8),
    };
  }

  // WebP container: RIFF....WEBP
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return { pixelFormat: "webp", ...readWebpDimensions(buffer) };
  }

  // BMP: BM
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    if (buffer.length < 26) return { pixelFormat: "bmp" };
    return {
      pixelFormat: "bmp",
      width: le32(buffer, 18),
      height: le32(buffer, 22),
    };
  }

  // TIFF: II.. or MM..
  if (
    (buffer[0] === 0x49 && buffer[1] === 0x49) ||
    (buffer[0] === 0x4d && buffer[1] === 0x4d)
  ) {
    return { pixelFormat: "tiff" };
  }

  // SVG: text-based, just check for <svg/<?xml leading bytes.
  const head = Array.from(buffer.subarray(0, Math.min(buffer.length, 256)))
    .map((c) => String.fromCharCode(c))
    .join("");
  if (/<svg\b/i.test(head) || /<\?xml[^>]*>\s*<svg/i.test(head)) {
    return { pixelFormat: "svg" };
  }

  return { pixelFormat: "unknown" };
}

function be32(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset] ?? 0) << 24) |
    ((buf[offset + 1] ?? 0) << 16) |
    ((buf[offset + 2] ?? 0) << 8) |
    (buf[offset + 3] ?? 0)
  );
}

function le32(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset] ?? 0) |
    ((buf[offset + 1] ?? 0) << 8) |
    ((buf[offset + 2] ?? 0) << 16) |
    ((buf[offset + 3] ?? 0) << 24)
  );
}

function le16(buf: Uint8Array, offset: number): number {
  return (buf[offset] ?? 0) | ((buf[offset + 1] ?? 0) << 8);
}

function be16(buf: Uint8Array, offset: number): number {
  return ((buf[offset] ?? 0) << 8) | (buf[offset + 1] ?? 0);
}

/**
 * Walk the JPEG markers looking for a SOFn frame (0xc0..0xcf except c4/c8/cc).
 * Bail after 1MB of header scan to avoid pathological inputs.
 */
function readJpegDimensions(buf: Uint8Array): { width?: number; height?: number } {
  let i = 2;
  const limit = Math.min(buf.length, 1024 * 1024);
  while (i < limit) {
    if (buf[i] !== 0xff) return {};
    while (i < limit && buf[i] === 0xff) i += 1;
    const marker = buf[i] ?? 0;
    i += 1;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      if (i + 7 >= limit) return {};
      const height = be16(buf, i + 3);
      const width = be16(buf, i + 5);
      return { width, height };
    }
    const segmentLen = be16(buf, i);
    if (segmentLen < 2) return {};
    i += segmentLen;
  }
  return {};
}

function readWebpDimensions(buf: Uint8Array): { width?: number; height?: number } {
  // VP8 lossy: bits at offset 26.. ; VP8L lossless: at 21.. ; VP8X: at 24..
  const fourcc = String.fromCharCode(...Array.from(buf.subarray(12, 16)));
  if (fourcc === "VP8 ") {
    if (buf.length < 30) return {};
    const width = le16(buf, 26) & 0x3fff;
    const height = le16(buf, 28) & 0x3fff;
    return { width, height };
  }
  if (fourcc === "VP8L") {
    if (buf.length < 25) return {};
    const b1 = buf[21] ?? 0;
    const b2 = buf[22] ?? 0;
    const b3 = buf[23] ?? 0;
    const b4 = buf[24] ?? 0;
    const width = ((b1 | ((b2 & 0x3f) << 8)) + 1) & 0x3fff;
    const height = (((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)) + 1) & 0x3fff;
    return { width, height };
  }
  if (fourcc === "VP8X") {
    if (buf.length < 30) return {};
    const width = 1 + le24(buf, 24);
    const height = 1 + le24(buf, 27);
    return { width, height };
  }
  return {};
}

function le24(buf: Uint8Array, offset: number): number {
  return (buf[offset] ?? 0) | ((buf[offset + 1] ?? 0) << 8) | ((buf[offset + 2] ?? 0) << 16);
}
