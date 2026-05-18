import { describe, expect, it } from "vitest";
import {
  createConvexProvider,
  ConvexNotImplementedError,
  createAppwriteProvider,
  AppwriteNotImplementedError,
  createDrizzleSqliteProvider,
  DrizzleSqliteNotImplementedError,
} from "../src/index.js";

// Supabase is no longer a stub as of Supabase arc slice 3 -- it has its
// own dedicated test suite in supabase-provider.test.ts (slice 4).
// Only the other three hosted-tier candidates remain stubs here.

const PROVISION_INPUT = {
  ventureSlug: "demo",
  ventureRoot: "/tmp/demo",
  adminEmail: "admin@local",
};

const APPLY_INPUT = {
  ventureRoot: "/tmp/demo",
  baseUrl: "http://localhost:8090",
  collections: [],
};

const INSTANCE = {
  ventureSlug: "demo",
  engine: "convex" as const,
  adminEmail: "admin@local",
  provisionedAt: "2026-05-13T00:00:00.000Z",
};

describe.each([
  ["convex", createConvexProvider, ConvexNotImplementedError],
  ["appwrite", createAppwriteProvider, AppwriteNotImplementedError],
  ["drizzle_sqlite", createDrizzleSqliteProvider, DrizzleSqliteNotImplementedError],
] as const)("stub provider %s", (name, factory, errClass) => {
  const provider = factory();

  it(`reports name="${name}"`, () => {
    expect(provider.name).toBe(name);
  });

  it("returns available()=false", async () => {
    await expect(provider.available()).resolves.toBe(false);
  });

  it("throws NotImplementedError from provision()", async () => {
    await expect(provider.provision(PROVISION_INPUT)).rejects.toBeInstanceOf(errClass);
  });

  it("throws NotImplementedError from applySchema()", async () => {
    await expect(provider.applySchema(APPLY_INPUT)).rejects.toBeInstanceOf(errClass);
  });

  it("throws NotImplementedError from export()", async () => {
    await expect(provider.export({ ...INSTANCE, engine: name }, [])).rejects.toBeInstanceOf(errClass);
  });
});
