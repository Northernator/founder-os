/**
 * renderPdfStep end-to-end smoke. Exercises the full pipeline
 *
 *   Handlebars-subset -> markdown -> branded HTML -> PdfEngine
 *
 * for the slice-2 proof descriptor (`coding-standards`, tier-D). Two
 * engines run: minimal-pdf (real PDF bytes) and html-only (HTML +
 * stub PDF). The renderer should produce status="stub" for tier-D
 * regardless of unresolved placeholders.
 */
import { readFile, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createHtmlOnlyPdfEngine,
  createMinimalPdfEngine,
  defaultPdfTemplateConfig,
  renderPdfStep,
  SLICE_2_PROOF_DESCRIPTOR,
  SLICE_2_PROOF_TEMPLATE,
} from "../src/node.js";
import type { BrandTokens } from "@founder-os/handoff-pack-core";

const TOKENS: BrandTokens = {
  logoSvgPath: ".brand/logo.svg",
  logoPngPath: ".brand/logo.png",
  companyName: "Acme & Co",
  colors: {
    primary: "#FF6600",
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

let ventureRoot: string;

beforeAll(async () => {
  ventureRoot = await mkdtemp(join(tmpdir(), "handoff-pack-render-"));
});

describe("renderPdfStep end-to-end (tier-D proof)", () => {
  it("renders the proof template through MinimalPdfEngine to a valid PDF on disk", async () => {
    const engine = createMinimalPdfEngine({
      now: () => new Date("2026-05-17T12:00:00.000Z"),
    });
    const result = await renderPdfStep({
      ventureRoot,
      descriptor: SLICE_2_PROOF_DESCRIPTOR,
      tokens: TOKENS,
      config: defaultPdfTemplateConfig(),
      engine,
      templateSource: SLICE_2_PROOF_TEMPLATE,
      context: {
        COMPANY_NAME: "Acme & Co",
        COMPANY_SLUG: "acme",
        CURRENT_DATE: "2026-05-17",
        // TODO_LANGUAGES + TODO_FRAMEWORKS deliberately omitted so the
        // lenient renderer surfaces them as TODO callouts -- this is
        // the tier-D contract.
      },
    });

    // Disk shape: PDF landed at the expected slot, has PDF magic bytes,
    // status is "stub" for tier-D.
    expect(result.pdfPath.endsWith("08-coding-standards.pdf")).toBe(true);
    expect(existsSync(result.pdfPath)).toBe(true);
    expect(result.bytesWritten).toBeGreaterThan(200);
    expect(result.status).toBe("stub");
    expect(result.renderedAt).toBe("2026-05-17T12:00:00.000Z");

    // PDF magic bytes: starts with %PDF- and ends with %%EOF.
    const bytes = await readFile(result.pdfPath);
    const head = bytes.subarray(0, 5).toString("ascii");
    expect(head).toBe("%PDF-");
    const tail = bytes.subarray(bytes.length - 6).toString("ascii");
    expect(tail).toMatch(/%%EOF/);
  });

  it("renders the proof template through HtmlOnlyPdfEngine and writes a sibling .pdf.html", async () => {
    const engine = createHtmlOnlyPdfEngine({
      now: () => new Date("2026-05-17T12:00:00.000Z"),
    });
    const result = await renderPdfStep({
      ventureRoot,
      descriptor: SLICE_2_PROOF_DESCRIPTOR,
      tokens: TOKENS,
      config: defaultPdfTemplateConfig(),
      engine,
      templateSource: SLICE_2_PROOF_TEMPLATE,
      context: {
        COMPANY_NAME: "Acme & Co",
        COMPANY_SLUG: "acme",
        CURRENT_DATE: "2026-05-17",
      },
    });

    expect(existsSync(result.pdfPath)).toBe(true);
    const htmlPath = `${result.pdfPath}.html`;
    expect(existsSync(htmlPath)).toBe(true);
    const html = await readFile(htmlPath, "utf-8");
    // The branded shell + the tier-D markdown both made it through.
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Coding Standards");
    expect(html).toContain("Acme &amp; Co");
    expect(html).toContain("<h1>Coding Standards</h1>");
    // Substituted placeholder.
    expect(html).toContain("acme</p>");
    // Lenient TODO callouts surfaced for the unresolved tier-D names.
    expect(html).toContain('class="hp-todo"');
    expect(html).toContain("TODO_LANGUAGES");
  });
});
