/**
 * Synthesise minimal-viable image headers in code so we don't ship
 * binary fixtures for the dimension reader. Real PNG/JPEG/GIF parsers
 * accept these; the headers are short and only carry the fields the
 * dimension reader looks at (signature + width/height bytes).
 */

/** Build a minimal PNG header (signature + IHDR for a w x h image). */
export function makePngHeader(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(24);
  // PNG signature.
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // IHDR length (13) + type "IHDR" at offset 8..15 (matches real PNGs).
  buf.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  // Width big-endian at offset 16, height big-endian at offset 20.
  buf[16] = (width >>> 24) & 0xff;
  buf[17] = (width >>> 16) & 0xff;
  buf[18] = (width >>> 8) & 0xff;
  buf[19] = width & 0xff;
  buf[20] = (height >>> 24) & 0xff;
  buf[21] = (height >>> 16) & 0xff;
  buf[22] = (height >>> 8) & 0xff;
  buf[23] = height & 0xff;
  return buf;
}

/** Build a minimal JPEG with a baseline SOF0 frame carrying w x h. */
export function makeJpegWithSof0(width: number, height: number): Uint8Array {
  // SOI + APP0 (JFIF) + SOF0 + EOI is enough for the dimension reader.
  const buf: number[] = [];
  buf.push(0xff, 0xd8); // SOI
  // APP0 segment, length 16, JFIF\0, 1.1, units 0, x/y density 0,0, thumb 0x0
  buf.push(0xff, 0xe0, 0x00, 0x10);
  buf.push(0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00);
  // SOF0: ff c0, length 11, precision 8, height (be16), width (be16), 1 component
  buf.push(0xff, 0xc0, 0x00, 0x0b, 0x08);
  buf.push((height >> 8) & 0xff, height & 0xff);
  buf.push((width >> 8) & 0xff, width & 0xff);
  buf.push(0x01, 0x01, 0x11, 0x00);
  buf.push(0xff, 0xd9); // EOI
  return new Uint8Array(buf);
}

/** Build a minimal GIF87a with width/height at offsets 6/8 (little-endian). */
export function makeGifHeader(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(10);
  buf.set([0x47, 0x49, 0x46, 0x38, 0x37, 0x61], 0);
  buf[6] = width & 0xff;
  buf[7] = (width >> 8) & 0xff;
  buf[8] = height & 0xff;
  buf[9] = (height >> 8) & 0xff;
  return buf;
}
