/**
 * prepareBrandAssetsStep -- HANDOFF_PACK stage's first step.
 *
 * NODE-ONLY. Lives behind the /node entry point.
 *
 * Reads 03_brand/brand-kit/brand-brief.json + venture.yaml, copies
 * the logo into 13_handoff_pack/.brand/, and writes:
 *   - brand-tokens.json    (extracted from brand-brief + venture)
 *   - pdf-template-config.json (defaults today; venture overrides
 *                              land in slice 5+)
 *
 * Fail-closed per spec sec 5: when BRAND has not shipped the step
 * throws HandoffPackBrandMissingError. No silent fallback to a
 * default theme -- that would defeat the point of branded docs.
 *
 * The logo copy is best-effort: when 03_brand/logo/exports/logo.svg
 * is absent (the user has shipped BRAND but not yet exported the
 * logo asset) the step writes brand-tokens.json with the conceptual
 * paths anyway and reports `logoCopied: false` in the result. Future
 * runs will pick up the logo without re-doing the rest of the work.
 *
 * Slice 5 wires this into the real HandoffPackStageRunner. Slice 2
 * just ships the helper so the orchestrator can call it; the test
 * suite drives it directly.
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  BrandTokensSchema,
  DEFAULT_HEADER_HEIGHT_MM,
  DEFAULT_FOOTER_HEIGHT_MM,
  DEFAULT_PAGE_MARGINS_MM,
  DEFAULT_PAGE_SIZE,
  HANDOFF_PACK_BRAND_DIR_NAME,
  PdfTemplateConfigSchema,
  type BrandTokens,
  type PdfTemplateConfig,
} from "@founder-os/handoff-pack-core";
import {
  getBrandKitDir,
  getHandoffPackBrandDir,
  getHandoffPackBrandLogoPngPath,
  getHandoffPackBrandLogoSvgPath,
  getHandoffPackBrandTokensPath,
  getHandoffPackPdfTemplateConfigPath,
  getLogoExportsDir,
} from "@founder-os/workspace-core";
import {
  HandoffPackBrandMissingError,
  type PrepareBrandAssetsResult,
} from "../types.js";

export type PrepareBrandAssetsOpts = {
  /** Venture root, absolute. e.g. /ventures/acme/. */
  ventureRoot: string;
  /**
   * Venture-display name. Mirrors VentureManifest.name. The brand-brief
   * already declares this so the helper falls back to brand-brief if
   * the caller doesn't have the manifest handy.
   */
  ventureName?: string;
  /**
   * Override the BrandBrief JSON path (defaults to
   * 03_brand/brand-kit/brand-brief.json). Tests use this to point at
   * a fixture.
   */
  brandBriefPath?: string;
  /**
   * Override the logo source path (defaults to
   * 03_brand/logo/exports/logo.svg). Tests use this for fixtures.
   */
  logoSvgSourcePath?: string;
  /**
   * Override the now() clock for deterministic tests.
   */
  now?: () => Date;
};

export async function prepareBrandAssetsStep(
  opts: PrepareBrandAssetsOpts
): Promise<PrepareBrandAssetsResult> {
  const now = opts.now ?? (() => new Date());
  const notes: string[] = [];

  // Resolve all paths up-front so error messages can name the exact
  // file that's missing.
  const brandBriefPath =
    opts.brandBriefPath ??
    `${getBrandKitDir(opts.ventureRoot)}/brand-brief.json`;
  const logoSvgSrc =
    opts.logoSvgSourcePath ??
    `${getLogoExportsDir(opts.ventureRoot)}/logo.svg`;
  const brandDir = getHandoffPackBrandDir(opts.ventureRoot);
  const logoSvgDst = getHandoffPackBrandLogoSvgPath(opts.ventureRoot);
  const logoPngDst = getHandoffPackBrandLogoPngPath(opts.ventureRoot);
  const tokensPath = getHandoffPackBrandTokensPath(opts.ventureRoot);
  const configPath = getHandoffPackPdfTemplateConfigPath(opts.ventureRoot);

  // Fail-closed when brand-brief.json is absent.
  if (!existsSync(brandBriefPath)) {
    throw new HandoffPackBrandMissingError(brandBriefPath);
  }

  // Parse brand-brief.json defensively -- we only need a subset of
  // the schema, so we read JSON and pick the fields we care about
  // rather than pulling in branding-core's full Zod parser (which
  // would add a workspace dep just for the schema). If branding-core
  // ever changes the field set, we just adapt this projector.
  let brief: unknown;
  try {
    brief = JSON.parse((await readFile(brandBriefPath, "utf-8")).replace(/^\uFEFF/, ""));
  } catch (cause) {
    throw new HandoffPackBrandMissingError(
      brandBriefPath,
      `BRAND artefact ${brandBriefPath} is not valid JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
  }

  const tokens = projectBrandTokens(brief, {
    ventureName: opts.ventureName,
    extractedAt: now().toISOString(),
  });
  // Slice 2 ships default config; slice 5 layers per-venture
  // overrides on top via HandoffPackConfig.
  const config = PdfTemplateConfigSchema.parse({
    pageSize: DEFAULT_PAGE_SIZE,
    margins: DEFAULT_PAGE_MARGINS_MM,
    headerHeightMm: DEFAULT_HEADER_HEIGHT_MM,
    footerHeightMm: DEFAULT_FOOTER_HEIGHT_MM,
    footerConfidentialityNote: "",
    accentH2Underline: true,
  });

  await mkdir(brandDir, { recursive: true });
  await writeFile(tokensPath, `${JSON.stringify(tokens, null, 2)}\n`, "utf-8");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  notes.push(`wrote ${tokensPath}`);
  notes.push(`wrote ${configPath}`);

  // Best-effort logo copy. The brand-tokens.json already records the
  // expected relative paths so a slice that re-runs after the founder
  // exports the logo picks it up without rewriting tokens.
  let logoCopied = false;
  if (existsSync(logoSvgSrc)) {
    await copyFile(logoSvgSrc, logoSvgDst);
    logoCopied = true;
    notes.push(`copied logo.svg from ${logoSvgSrc}`);
    // Slice 2 doesn't ship SVG -> PNG rasterisation (no dep on
    // sharp / svg2img today). Slice 5 will -- the PNG path is
    // recorded in brand-tokens.json so the renderer has the slot
    // ready. For now we write a placeholder PNG with a clear note
    // so consumers can detect it.
    const placeholderPng = new Uint8Array([
      // 8-byte PNG signature + IHDR-less placeholder. Real PNG decoders
      // will reject this, which is intentional -- we want callers to
      // notice the absent rasterisation and not silently embed garbage.
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    await writeFile(logoPngDst, placeholderPng);
    notes.push(`wrote logo.png placeholder (real rasterisation lands slice 5)`);
  } else {
    notes.push(
      `logo source not found: ${logoSvgSrc} (re-run after BRAND emits the logo)`
    );
  }

  return {
    brandDir,
    tokens,
    config,
    logoCopied,
    notes,
  };
}

// ---------------------------------------------------------------------------
// brand-brief.json -> BrandTokens projection
// ---------------------------------------------------------------------------

/**
 * Extract a BrandTokens record from a raw brand-brief.json object.
 * Defensive: missing fields fall back to handoff-pack-core's
 * documented defaults. Exported so tests can drive the projection
 * without a full prepare cycle.
 */
export function projectBrandTokens(
  brief: unknown,
  opts: { ventureName?: string; extractedAt: string }
): BrandTokens {
  const b = (brief as Record<string, unknown>) ?? {};
  const palette = (b.colorPalette as Record<string, unknown>) ?? {};
  const typography = (b.typography as Record<string, unknown>) ?? {};
  const companyName =
    opts.ventureName ??
    (typeof b.companyName === "string" ? b.companyName : "Unknown Company");

  const tokens = {
    logoSvgPath: `${HANDOFF_PACK_BRAND_DIR_NAME}/logo.svg`,
    logoPngPath: `${HANDOFF_PACK_BRAND_DIR_NAME}/logo.png`,
    companyName,
    colors: {
      primary: asHex(palette.primary, "#1F2937"),
      secondary: asHex(palette.secondary, "#6B7280"),
      background: asHex(palette.background, "#FFFFFF"),
      text: asHex(palette.text, "#111827"),
    },
    fonts: {
      heading: asString(typography.headingFont, "Inter"),
      body: asString(typography.bodyFont, "Inter"),
      mono: asString(typography.monoFont, "JetBrains Mono"),
    },
    extractedAt: opts.extractedAt,
  };
  // Parse through the schema so callers get the typed (validated)
  // record. Any drift from handoff-pack-core's contract throws here
  // rather than blowing up downstream renders.
  return BrandTokensSchema.parse(tokens);
}

function asHex(v: unknown, fallback: string): string {
  if (typeof v !== "string") return fallback;
  return /^#[0-9A-Fa-f]{6}$/.test(v) ? v.toUpperCase() : fallback;
}

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

/**
 * PdfTemplateConfig with all defaults applied. Exported for callers
 * that need a config without driving prepareBrandAssetsStep (e.g. the
 * orchestrator running in --dry-run mode).
 */
export function defaultPdfTemplateConfig(): PdfTemplateConfig {
  return PdfTemplateConfigSchema.parse({
    pageSize: DEFAULT_PAGE_SIZE,
    margins: DEFAULT_PAGE_MARGINS_MM,
    headerHeightMm: DEFAULT_HEADER_HEIGHT_MM,
    footerHeightMm: DEFAULT_FOOTER_HEIGHT_MM,
    footerConfidentialityNote: "",
    accentH2Underline: true,
  });
}
