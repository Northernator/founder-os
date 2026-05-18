/**
 * renderAllStubsStep + renderHandoffPackArtefactsStep tests.
 *
 * Slice 5 of the handoff-pack arc. The walker iterates DOC_MANIFEST,
 * calls renderPdfStep per descriptor, and accumulates an
 * InventoryEntry[]. The orchestrator wraps prepareBrandAssetsStep +
 * walker and assembles a HandoffPackInventory.
 *
 * These tests drive everything against a tmpdir on real disk because
 * the minimal-pdf engine writes binary bytes via node:fs/promises and
 * the orchestrator's prepareBrandAssetsStep does likewise. The
 * stage-runners side mocks the orchestrator at the module boundary;
 * here we exercise the actual implementation end-to-end on a tiny
 * 1-descriptor template fixture.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import {
  renderAllStubsStep,
  renderHandoffPackArtefactsStep,
  renderInventoryMarkdown,
  createMinimalPdfEngine,
  defaultPdfTemplateConfig,
} from "../src/node.js";
import type { BrandTokens } from "@founder-os/handoff-pack-core";
import {
  HandoffPackInventorySchema,
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

// Tier-D template the manifest's slot 0 references. We point
// templatesRoot at a fixture directory and lay this down per-test.
const TIER_D_TEMPLATE_BODY = `---
docId: company-brief
tier: A
category: 00-company-control
title: Company Brief
---

# {{COMPANY_NAME}} -- Company Brief

Document for **{{COMPANY_NAME}}** (\`{{COMPANY_SLUG}}\`). Last updated **{{CURRENT_DATE}}**.

Primary brand colour: {{BRAND_PRIMARY_COLOR}}.
`;

const NOW = () => new Date("2026-05-17T12:00:00.000Z");

let ventureRoot: string;
let templatesRoot: string;

beforeEach(async () => {
  ventureRoot = await mkdtemp(join(tmpdir(), "handoff-pack-stubs-v-"));
  templatesRoot = await mkdtemp(join(tmpdir(), "handoff-pack-stubs-t-"));
});

afterEach(async () => {
  if (ventureRoot && existsSync(ventureRoot)) await rm(ventureRoot, { recursive: true, force: true });
  if (templatesRoot && existsSync(templatesRoot)) await rm(templatesRoot, { recursive: true, force: true });
});

async function placeTemplate(relPath: string, body: string): Promise<void> {
  const full = join(templatesRoot, relPath);
  await mkdir(join(templatesRoot, relPath.split("/").slice(0, -1).join("/")), { recursive: true });
  await writeFile(full, body, "utf-8");
}

describe("renderAllStubsStep", () => {
  it("returns one InventoryEntry per descriptor when limit=1 and the template exists", async () => {
    // The first manifest entry references this template path.
    await placeTemplate("00-company-control/00-company-brief.md.hbs", TIER_D_TEMPLATE_BODY);
    const result = await renderAllStubsStep({
      ventureRoot,
      ventureName: "Acme Inc",
      ventureSlug: "acme",
      tokens: TOKENS,
      config: defaultPdfTemplateConfig(),
      engine: createMinimalPdfEngine({ now: NOW }),
      templatesRoot,
      now: NOW,
      limit: 1,
    });
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.docId).toBe("company-brief");
    expect(["generated", "stub", "partial"]).toContain(entry.status);
    expect(entry.pdfRelativePath).toMatch(/company-brief\.pdf$/);
    expect(entry.lastRenderedAt).toBe("2026-05-17T12:00:00.000Z");
  });

  it("marks a descriptor 'failed' when its template is missing on disk and continues the walk", async () => {
    // Place only the second template; first one is intentionally missing.
    // The walker should fail-row the first, succeed-row the second.
    const tier2Body = TIER_D_TEMPLATE_BODY.replace("docId: company-brief", "docId: founder-vision")
      .replace("category: 00-company-control", "category: 00-company-control");
    await placeTemplate("00-company-control/01-founder-vision.md.hbs", tier2Body);
    const result = await renderAllStubsStep({
      ventureRoot,
      ventureName: "Acme Inc",
      ventureSlug: "acme",
      tokens: TOKENS,
      config: defaultPdfTemplateConfig(),
      engine: createMinimalPdfEngine({ now: NOW }),
      templatesRoot,
      now: NOW,
      limit: 2,
    });
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]!.status).toBe("failed");
    expect(result.entries[0]!.failureReason).toBeDefined();
    expect(result.counts.failed).toBe(1);
    // Second descriptor rendered fine.
    expect(["generated", "stub", "partial"]).toContain(result.entries[1]!.status);
  });

  it("respects excludeTiers by marking suppressed descriptors as 'pending'", async () => {
    await placeTemplate("00-company-control/00-company-brief.md.hbs", TIER_D_TEMPLATE_BODY);
    const result = await renderAllStubsStep({
      ventureRoot,
      ventureName: "Acme Inc",
      ventureSlug: "acme",
      tokens: TOKENS,
      config: defaultPdfTemplateConfig(),
      engine: createMinimalPdfEngine({ now: NOW }),
      templatesRoot,
      now: NOW,
      limit: 1,
      // First descriptor is tier A in the manifest -- exclude it.
      excludeTiers: ["A"],
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.status).toBe("pending");
    expect(result.counts.pending).toBe(1);
    expect(result.counts.generated).toBe(0);
    expect(result.counts.stub).toBe(0);
  });

  it("PDF bytes actually land on disk for each rendered descriptor", async () => {
    await placeTemplate("00-company-control/00-company-brief.md.hbs", TIER_D_TEMPLATE_BODY);
    await renderAllStubsStep({
      ventureRoot,
      ventureName: "Acme Inc",
      ventureSlug: "acme",
      tokens: TOKENS,
      config: defaultPdfTemplateConfig(),
      engine: createMinimalPdfEngine({ now: NOW }),
      templatesRoot,
      now: NOW,
      limit: 1,
    });
    // The renderPdfStep resolves the output via workspace-core's
    // getHandoffPackDocPdfPath helper, which lands under
    // <ventureRoot>/13_handoff_pack/00-company-control/<slot>-<id>.pdf.
    const pdfPath = join(
      ventureRoot,
      "13_handoff_pack",
      "00-company-control",
      "00-company-brief.pdf",
    );
    expect(existsSync(pdfPath)).toBe(true);
  });
});

describe("renderHandoffPackArtefactsStep -- orchestration", () => {
  it("requires brand-brief.json and throws HandoffPackBrandMissingError when absent", async () => {
    await expect(
      renderHandoffPackArtefactsStep({
        ventureRoot,
        ventureName: "Acme Inc",
        ventureSlug: "acme",
        now: NOW,
        walkOverrides: { templatesRoot, limit: 1 },
      }),
    ).rejects.toThrowError(/BRAND stage has not shipped/);
  });

  it("returns a HandoffPackInventory that parses the contract schema", async () => {
    // Place brand-brief.json so prepareBrandAssetsStep succeeds.
    await mkdir(join(ventureRoot, "03_brand", "brand-kit"), { recursive: true });
    await writeFile(
      join(ventureRoot, "03_brand", "brand-kit", "brand-brief.json"),
      JSON.stringify({
        companyName: "Acme Inc",
        colorPalette: {
          primary: "#FF6600",
          secondary: "#6B7280",
          background: "#FFFFFF",
          text: "#111827",
        },
        typography: {
          headingFont: "Inter",
          bodyFont: "Inter",
          monoFont: "JetBrains Mono",
        },
      }),
      "utf-8",
    );
    await placeTemplate("00-company-control/00-company-brief.md.hbs", TIER_D_TEMPLATE_BODY);
    const result = await renderHandoffPackArtefactsStep({
      ventureRoot,
      ventureName: "Acme Inc",
      ventureSlug: "acme",
      now: NOW,
      walkOverrides: { templatesRoot, limit: 1 },
    });
    expect(result.inventory.totalDocs).toBe(1);
    expect(result.inventory.ventureName).toBe("Acme Inc");
    // The inventory should parse through the contract schema; if the
    // walker's row shape drifts away from InventoryEntrySchema this
    // throws here.
    HandoffPackInventorySchema.parse(result.inventory);
    expect(result.inventoryMarkdown.length).toBeGreaterThan(0);
    expect(result.inventoryMarkdown).toContain("Acme Inc");
  });
});

describe("renderInventoryMarkdown -- pure builder", () => {
  it("surfaces per-doc rows + tier breakdown + status breakdown", () => {
    const body = renderInventoryMarkdown({
      inventory: {
        generatedAt: "2026-05-17T00:00:00.000Z",
        ventureSlug: "acme",
        ventureName: "Acme Inc",
        totalDocs: 2,
        entries: [
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
            docId: "cap-table",
            category: "00-company-control",
            slot: "03",
            title: "Cap Table",
            tier: "D",
            status: "stub",
            pdfRelativePath: "00-company-control/03-cap-table.pdf",
            lastRenderedAt: "2026-05-17T00:00:00.000Z",
          },
        ],
        rolePacks: {},
      },
    });
    expect(body).toContain("Handoff pack -- Acme Inc");
    expect(body).toContain("A=1");
    expect(body).toContain("D=1");
    expect(body).toContain("generated=1");
    expect(body).toContain("stub=1");
    expect(body).toContain("Company Brief");
    expect(body).toContain("Cap Table");
    // Tier and status badges land as readable labels.
    expect(body).toContain("A (golden)");
    expect(body).toContain("D (stub)");
  });
});
