/**
 * Real-fs smoke test for the Node hash + stage helpers. Uses a per-test
 * tmpdir; nothing escapes the package boundary.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashFile } from "../src/node/hash-file";
import { stageOriginal } from "../src/node/stage-original";
import { probeMagicBytes } from "../src/node/magic-bytes";

describe("hashFile (real fs)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "vault-hash-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns deterministic sha256 for the same content", async () => {
    const a = join(tmp, "a.txt");
    const b = join(tmp, "b.txt");
    await writeFile(a, "hello world");
    await writeFile(b, "hello world");
    expect(await hashFile(a)).toBe(await hashFile(b));
  });

  it("returns different hashes for different content", async () => {
    const a = join(tmp, "a.txt");
    const b = join(tmp, "b.txt");
    await writeFile(a, "hello world");
    await writeFile(b, "goodbye world");
    expect(await hashFile(a)).not.toBe(await hashFile(b));
  });

  it("matches the well-known sha256 of 'hello world'", async () => {
    const a = join(tmp, "a.txt");
    await writeFile(a, "hello world");
    expect(await hashFile(a)).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });
});

describe("stageOriginal (real fs)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "vault-stage-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("copies the source into _vault/_import-cache + returns sharded relative path", async () => {
    const src = join(tmp, "src.txt");
    await writeFile(src, "stage me");
    const result = await stageOriginal({
      absoluteSourcePath: src,
      workspaceRoot: tmp,
      contentHash: "deadbeef0001",
      fileExtension: "txt",
    });
    expect(result.cachedRelativePath).toContain("_vault/_import-cache/de/adbeef0001.txt");
    expect(result.byteSize).toBe("stage me".length);
    const copied = await readFile(join(tmp, result.cachedRelativePath), "utf8");
    expect(copied).toBe("stage me");
  });

  it("is idempotent -- second stage call with same hash reuses the existing cache file", async () => {
    const src = join(tmp, "src.txt");
    await writeFile(src, "stage me");
    const first = await stageOriginal({
      absoluteSourcePath: src,
      workspaceRoot: tmp,
      contentHash: "deadbeef0002",
      fileExtension: "txt",
    });
    // overwrite the source to prove the second call does NOT copy again
    await writeFile(src, "different content");
    const second = await stageOriginal({
      absoluteSourcePath: src,
      workspaceRoot: tmp,
      contentHash: "deadbeef0002",
      fileExtension: "txt",
    });
    expect(second.cachedRelativePath).toBe(first.cachedRelativePath);
    const cached = await readFile(join(tmp, first.cachedRelativePath), "utf8");
    expect(cached).toBe("stage me");
  });
});

describe("probeMagicBytes (real fs)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "vault-magic-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("identifies a PDF by magic bytes regardless of filename", async () => {
    const file = join(tmp, "noext");
    await writeFile(file, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]));
    const result = await probeMagicBytes(file);
    expect(result?.sourceType).toBe("document");
    expect(result?.mime).toBe("application/pdf");
  });

  it("identifies a PNG by magic bytes", async () => {
    const file = join(tmp, "noext");
    await writeFile(
      file,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
    );
    const result = await probeMagicBytes(file);
    expect(result?.sourceType).toBe("image");
    expect(result?.mime).toBe("image/png");
  });

  it("returns null when no signature matches", async () => {
    const file = join(tmp, "blob");
    await writeFile(file, Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]));
    expect(await probeMagicBytes(file)).toBeNull();
  });
});
