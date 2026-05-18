import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMinimalPdfEngine,
  defaultPdfTemplateConfig,
  renderRolePacksStep,
} from "../src/node.js";
import type {
  BrandTokens,
  InventoryEntry,
  RolePackDescriptor,
} from "@founder-os/handoff-pack-core";

const TOKENS: BrandTokens = {
  logoSvgPath: ".brand/logo.svg",
  logoPngPath: ".brand/logo.png",
  companyName: "Acme Inc",
  colors: {
    primary: "#1F2937",
    secondary: "#6B7280",
    background: "#FFFFFF",
    text: "#111827",
  },
  fonts: {
    heading: "Inter",
    body: "Inter",
    mono: "JetBrains Mono",
  },
  extractedAt: "2026-05-17T00:00:00.000Z",
};

const NOW = () => new Date("2026-05-17T12:00:00.000Z");

const PACK: RolePackDescriptor = {
  role: "founder",
  title: "Founder Pack",
  introText: "Read this first.",
  docIds: ["company-brief", "missing-doc", "failed-doc"],
};

const ENTRIES: InventoryEntry[] = [
  {
    docId: "company-brief",
    category: "00-company-control",
    slot: "00",
    title: "Company Brief",
    tier: "A",
    status: "generated",
    pdfRelativePath: "00-company-control/00-company-brief.pdf",
    lastRenderedAt: "2026-05-17T00:00:00.000Z",
  },
  {
    docId: "failed-doc",
    category: "00-company-control",
    slot: "99",
    title: "Failed Doc",
    tier: "A",
    status: "failed",
    pdfRelativePath: "00-company-control/99-failed-doc.pdf",
    failureReason: "forced",
  },
];

let ventureRoot: string;

beforeEach(async () => {
  ventureRoot = await mkdtemp(join(tmpdir(), "handoff-pack-role-packs-"));
});

afterEach(async () => {
  if (ventureRoot && existsSync(ventureRoot)) {
    await rm(ventureRoot, { recursive: true, force: true });
  }
});

describe("renderRolePacksStep", () => {
  it("renders a role-pack PDF and reports unavailable docs", async () => {
    const result = await renderRolePacksStep({
      ventureRoot,
      ventureName: "Acme Inc",
      ventureSlug: "acme",
      tokens: TOKENS,
      config: defaultPdfTemplateConfig(),
      engine: createMinimalPdfEngine({ now: NOW }),
      now: NOW,
      inventoryEntries: ENTRIES,
      rolePacks: [PACK],
    });

    expect(result.counts.generated).toBe(1);
    expect(result.counts.failed).toBe(0);
    expect(result.rolePacks.founder).toBe("generated");
    expect(result.results[0]!.docsIncluded).toBe(1);
    expect(result.results[0]!.docsUnavailable).toBe(2);
    expect(result.results[0]!.renderedAt).toBe("2026-05-17T12:00:00.000Z");
    expect(existsSync(join(ventureRoot, "13_handoff_pack", "role-packs", "founder-pack.pdf"))).toBe(true);
  });

  it("marks packs skipped when includeRoles excludes them", async () => {
    const result = await renderRolePacksStep({
      ventureRoot,
      ventureName: "Acme Inc",
      ventureSlug: "acme",
      tokens: TOKENS,
      config: defaultPdfTemplateConfig(),
      engine: createMinimalPdfEngine({ now: NOW }),
      now: NOW,
      inventoryEntries: ENTRIES,
      rolePacks: [PACK],
      includeRoles: [],
    });

    expect(result.counts.generated).toBe(0);
    expect(result.counts.skipped).toBe(1);
    expect(result.rolePacks.founder).toBe("skipped");
    expect(result.results[0]!.bytesWritten).toBe(0);
    expect(existsSync(join(ventureRoot, "13_handoff_pack", "role-packs", "founder-pack.pdf"))).toBe(false);
  });

  it("marks packs failed when the engine throws", async () => {
    const result = await renderRolePacksStep({
      ventureRoot,
      ventureName: "Acme Inc",
      ventureSlug: "acme",
      tokens: TOKENS,
      config: defaultPdfTemplateConfig(),
      now: NOW,
      inventoryEntries: ENTRIES,
      rolePacks: [PACK],
      engine: {
        id: "minimal-pdf",
        label: "Throwing test engine",
        async render() {
          await mkdir(join(ventureRoot, "13_handoff_pack"), { recursive: true });
          throw new Error("engine boom");
        },
      },
    });

    expect(result.counts.failed).toBe(1);
    expect(result.rolePacks.founder).toBe("failed");
    expect(result.results[0]!.failureReason).toContain("engine boom");
  });
});
