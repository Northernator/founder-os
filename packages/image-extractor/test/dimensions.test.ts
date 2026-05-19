import { describe, expect, it } from "vitest";
import { readImageHeader } from "../src/dimensions";
import { makeGifHeader, makeJpegWithSof0, makePngHeader } from "./fixtures";

describe("readImageHeader", () => {
  it("reads PNG dimensions", () => {
    const header = readImageHeader(makePngHeader(320, 240));
    expect(header.pixelFormat).toBe("png");
    expect(header.width).toBe(320);
    expect(header.height).toBe(240);
  });

  it("reads JPEG dimensions from SOF0", () => {
    const header = readImageHeader(makeJpegWithSof0(800, 600));
    expect(header.pixelFormat).toBe("jpeg");
    expect(header.width).toBe(800);
    expect(header.height).toBe(600);
  });

  it("reads GIF dimensions", () => {
    const header = readImageHeader(makeGifHeader(128, 64));
    expect(header.pixelFormat).toBe("gif");
    expect(header.width).toBe(128);
    expect(header.height).toBe(64);
  });

  it("returns unknown for non-image input", () => {
    const buf = new TextEncoder().encode("just text content");
    expect(readImageHeader(buf).pixelFormat).toBe("unknown");
  });

  it("detects SVG via xml prologue", () => {
    const svg = new TextEncoder().encode('<?xml version="1.0"?><svg width="10" height="10"/>');
    expect(readImageHeader(svg).pixelFormat).toBe("svg");
  });

  it("survives a truncated PNG (returns format, no dimensions)", () => {
    const buf = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const header = readImageHeader(buf);
    expect(header.pixelFormat).toBe("png");
    expect(header.width).toBeUndefined();
    expect(header.height).toBeUndefined();
  });
});
