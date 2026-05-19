/**
 * Real-fs smoke test for the Node walker. Uses a per-test tmpdir so
 * nothing escapes the package boundary.
 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { walkFolder } from "../src/node/walk-folder";
import { resolveFile } from "../src/node/resolve-file";

describe("walkFolder (real fs)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "vault-walk-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("finds files recursively + skips dot-files", async () => {
    await mkdir(join(tmp, "sub"), { recursive: true });
    await writeFile(join(tmp, "a.txt"), "a");
    await writeFile(join(tmp, ".hidden"), "h");
    await writeFile(join(tmp, ".DS_Store"), "ds");
    await writeFile(join(tmp, "sub", "b.md"), "b");

    const files = await walkFolder(tmp);
    const names = files.map((f) => f.originalName).sort();
    expect(names).toEqual(["a.txt", "b.md"]);
  });

  it("returns empty array for non-existent path", async () => {
    const files = await walkFolder(join(tmp, "no-such-dir"));
    expect(files).toEqual([]);
  });
});

describe("resolveFile (real fs)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "vault-resolve-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns DiscoveredFile for an existing file", async () => {
    const file = join(tmp, "hello.txt");
    await writeFile(file, "hi");
    const resolved = await resolveFile(file);
    expect(resolved.originalName).toBe("hello.txt");
    expect(resolved.absolutePath).toBe(file);
  });

  it("throws when given a directory", async () => {
    await expect(resolveFile(tmp)).rejects.toThrow();
  });
});
