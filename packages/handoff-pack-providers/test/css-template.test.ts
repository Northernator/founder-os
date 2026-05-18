/**
 * css-template tests. Asserts that the branded CSS shell contains
 * the actual brand tokens the renderer was handed, and that the
 * wrapped HTML carries the descriptor's title + the company name in
 * the header band.
 */
import { describe, expect, it } from "vitest";
import {
  buildBrandCss,
  wrapBrandedHtml,
  SLICE_2_PROOF_DESCRIPTOR,
  defaultPdfTemplateConfig,
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

describe("buildBrandCss", () => {
  it("inlines brand primary + secondary hex values as CSS custom properties", () => {
    const css = buildBrandCss(TOKENS, defaultPdfTemplateConfig());
    expect(css).toContain("--hp-color-primary: #FF6600");
    expect(css).toContain("--hp-color-secondary: #6B7280");
    expect(css).toContain('--hp-font-heading: "Inter"');
  });
});

describe("wrapBrandedHtml", () => {
  it("renders the company name into the header band and HTML-escapes it", () => {
    const html = wrapBrandedHtml({
      bodyHtml: "<p>body</p>",
      descriptor: SLICE_2_PROOF_DESCRIPTOR,
      tokens: TOKENS,
      config: defaultPdfTemplateConfig(),
    });
    // Company name is HTML-escaped (& -> &amp;).
    expect(html).toContain(
      '<span class="hp-company-name">Acme &amp; Co</span>'
    );
    // Doc category surfaces a human label (Engineering).
    expect(html).toMatch(
      /<span class="hp-doc-category">Engineering<\/span>/
    );
    // Doc title appears in the footer meta and the document <title>.
    expect(html).toContain("Coding Standards");
    expect(html).toContain("<!doctype html>");
  });
});
