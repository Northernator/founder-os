/**
 * Slice 6 -- engineering-tier Golden step tests.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createApiSpecificationStep,
  createDatabaseSchemaStep,
  createDeveloperBriefStep,
  createTechnicalSpecificationStep,
  type GoldenStepContext,
} from "../../src/node/golden/index.js";
import type { BrandTokens } from "@founder-os/handoff-pack-core";

const TOKENS: BrandTokens = {
  logoSvgPath: ".brand/logo.svg",
  logoPngPath: ".brand/logo.png",
  companyName: "Acme Inc",
  colors: { primary: "#1F2937", secondary: "#6B7280", background: "#FFFFFF", text: "#111827" },
  fonts: { heading: "Inter", body: "Inter", mono: "JetBrains Mono" },
  extractedAt: "2026-05-17T00:00:00.000Z",
};
const NOW = () => new Date("2026-05-17T12:00:00.000Z");

let ventureRoot: string;

beforeEach(async () => {
  ventureRoot = await mkdtemp(join(tmpdir(), "golden-engineering-"));
});

afterEach(async () => {
  if (ventureRoot && existsSync(ventureRoot)) {
    await rm(ventureRoot, { recursive: true, force: true });
  }
});

function ctx(extra: Partial<GoldenStepContext> = {}): GoldenStepContext {
  return {
    ventureRoot,
    ventureName: "Acme Inc",
    ventureSlug: "acme",
    brandTokens: TOKENS,
    now: NOW,
    ...extra,
  };
}

async function seedBackendExport(payload: Record<string, unknown>): Promise<void> {
  const dir = join(ventureRoot, "12_backend");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "backend-export.json"), JSON.stringify(payload, null, 2), "utf-8");
}

async function seedSpecCanvas(payload: Record<string, unknown>): Promise<void> {
  const dir = join(ventureRoot, "06_product", "specs");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "spec-canvas.json"), JSON.stringify(payload, null, 2), "utf-8");
}

describe("createDeveloperBriefStep", () => {
  it("merges stack from spec-canvas + backend-export", async () => {
    await seedSpecCanvas({
      productName: "Acme OS",
      stack: ["TypeScript", "React", "Tauri"],
      constraints: ["GDPR-compliant", "Sub-second cold start"],
    });
    await seedBackendExport({ framework: "Hono", database: "SQLite", auth: { provider: "magic-link" } });
    const result = await createDeveloperBriefStep(ctx());
    expect(result.placeholders.STACK).toContain("TypeScript");
    expect(result.placeholders.STACK).toContain("Backend: Hono");
    expect(result.placeholders.STACK).toContain("Database: SQLite");
    expect(result.placeholders.CONSTRAINTS).toContain("GDPR-compliant");
  });

  it("CONSTRAINTS TODO when none captured", async () => {
    await seedSpecCanvas({ productName: "Acme OS" });
    const result = await createDeveloperBriefStep(ctx());
    expect(result.placeholders.CONSTRAINTS).toMatch(/TODO/);
  });
});

describe("createTechnicalSpecificationStep", () => {
  it("ARCHITECTURE block reflects backend-export collection + endpoint counts", async () => {
    await seedBackendExport({
      framework: "Hono",
      database: "SQLite",
      collections: [{ name: "users" }, { name: "ventures" }, { name: "documents" }],
      apis: [
        { method: "POST", path: "/auth/login" },
        { method: "GET", path: "/ventures" },
      ],
    });
    const result = await createTechnicalSpecificationStep(ctx());
    expect(result.placeholders.ARCHITECTURE).toContain("Hono");
    expect(result.placeholders.ARCHITECTURE).toContain("3 domain collections");
    expect(result.placeholders.ARCHITECTURE).toContain("2 REST endpoints");
  });
});

describe("createDatabaseSchemaStep", () => {
  it("renders one section per collection with field table", async () => {
    await seedBackendExport({
      collections: [
        {
          name: "users",
          fields: [
            { name: "id", type: "uuid", required: true, indexed: true },
            { name: "email", type: "string", required: true, indexed: true },
            { name: "createdAt", type: "timestamp", required: true },
          ],
          indexes: ["users_email_unique"],
        },
      ],
    });
    const result = await createDatabaseSchemaStep(ctx());
    expect(result.placeholders.COLLECTIONS).toContain("### `users`");
    expect(result.placeholders.COLLECTIONS).toContain("`email`");
    expect(result.placeholders.COLLECTIONS).toContain("users_email_unique");
  });

  it("TODO callout when backend-export missing", async () => {
    const result = await createDatabaseSchemaStep(ctx());
    expect(result.placeholders.COLLECTIONS).toMatch(/TODO/);
  });
});

describe("createApiSpecificationStep", () => {
  it("renders endpoint table from backend-export.apis", async () => {
    await seedBackendExport({
      auth: { provider: "magic-link", strategy: "session-cookie", mfa: false },
      apis: [
        { method: "GET", path: "/ventures", description: "List ventures" },
        { method: "POST", path: "/ventures", description: "Create venture", auth: "user" },
      ],
    });
    const result = await createApiSpecificationStep(ctx());
    expect(result.placeholders.ENDPOINTS).toContain("| GET | `/ventures`");
    expect(result.placeholders.ENDPOINTS).toContain("Create venture");
    expect(result.placeholders.AUTH).toContain("magic-link");
    expect(result.placeholders.AUTH).toContain("session-cookie");
  });

  it("falls back to endpoints[] when apis missing", async () => {
    await seedBackendExport({
      endpoints: [{ method: "GET", path: "/health" }],
    });
    const result = await createApiSpecificationStep(ctx());
    expect(result.placeholders.ENDPOINTS).toContain("/health");
  });
});
