import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";

import { createPocketbaseProvider } from "../src/pocketbase-provider.js";
import { PocketbaseBinaryMissingError } from "../src/binary.js";

let createdRoots: string[] = [];

function freshVentureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "fo-backend-test-"));
  createdRoots.push(root);
  return root;
}

afterEach(() => {
  for (const r of createdRoots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  createdRoots = [];
});

describe("createPocketbaseProvider", () => {
  it("reports the engine name correctly", () => {
    const p = createPocketbaseProvider({ adminPassword: "x" });
    expect(p.name).toBe("pocketbase");
  });

  it("available() returns true (binary probe happens in provision)", async () => {
    const p = createPocketbaseProvider({ adminPassword: "x" });
    await expect(p.available()).resolves.toBe(true);
  });

  it("provision throws PocketbaseBinaryMissingError when the binary is absent", async () => {
    const root = freshVentureRoot();
    const p = createPocketbaseProvider({ adminPassword: "x" });
    await expect(
      p.provision({
        ventureSlug: "demo",
        ventureRoot: root,
        adminEmail: "admin@local",
      })
    ).rejects.toBeInstanceOf(PocketbaseBinaryMissingError);
  });

  it("provision bootstraps 12_backend/pocketbase/ directory tree even when binary is missing", async () => {
    const root = freshVentureRoot();
    const p = createPocketbaseProvider({ adminPassword: "x" });
    await p
      .provision({
        ventureSlug: "demo",
        ventureRoot: root,
        adminEmail: "admin@local",
      })
      .catch(() => {
        /* expected -- binary not installed */
      });
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(root, "12_backend", "pocketbase"))).toBe(true);
    expect(existsSync(join(root, "12_backend", "pocketbase", "pb_migrations"))).toBe(true);
    expect(existsSync(join(root, "12_backend", "pocketbase", "pb_hooks"))).toBe(true);
    expect(existsSync(join(root, "12_backend", "pocketbase", "pb_data"))).toBe(true);
    expect(existsSync(join(root, "12_backend", "sdk"))).toBe(true);
  });
});
