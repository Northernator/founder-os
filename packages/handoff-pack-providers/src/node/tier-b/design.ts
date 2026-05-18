/**
 * Slice 7 -- design-tier Tier-B steps.
 *
 * Three docs:
 *   - brand-strategy   -- personality + positioning + promise paragraph.
 *   - logo-pack        -- logo paths + usage rules from brand-tokens.
 *   - design-handoff   -- sliders + tokens + html-hash from handoff-export.
 *
 * NODE-ONLY. brand-strategy is LLM-enabled. logo-pack and design-handoff
 * are pure render (LLM would hallucinate spacing rules / token names).
 */
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  getBrandKitDir,
  getHandoffExportPath,
  getLogoExportsDir,
} from "@founder-os/workspace-core";
import {
  bulletList,
  callLlmStrict,
  isoDate,
  readDirIfExists,
  readJsonIfExists,
  todoCallout,
  truncate,
} from "../golden/helpers.js";
import type { GoldenStep, GoldenStepResult } from "./types.js";

type BrandBriefLike = {
  personality?: string | string[];
  positioning?: string;
  promise?: string;
  mission?: string;
  tone?: string | string[];
  values?: string[];
};

type HandoffExportLike = {
  source?: string;
  parameters?: Array<{ key?: string; value?: unknown; label?: string }>;
  tokens?: Record<string, unknown>;
  html?: string;
  prompt?: string;
};

async function loadBrandBrief(ventureRoot: string): Promise<BrandBriefLike | null> {
  return readJsonIfExists<BrandBriefLike>(
    join(getBrandKitDir(ventureRoot), "brand-brief.json")
  );
}

// ---------------------------------------------------------------------------
// brand-strategy
// ---------------------------------------------------------------------------

export const createBrandStrategyStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const brandBrief = await loadBrandBrief(ctx.ventureRoot);
  if (brandBrief) sourcesRead.push("03_brand/brand-kit/brand-brief.json");

  const personality = Array.isArray(brandBrief?.personality)
    ? brandBrief!.personality!.join(", ")
    : (brandBrief?.personality ?? "").trim();
  const positioning = (brandBrief?.positioning ?? "").trim();
  const promise = (brandBrief?.promise ?? "").trim();

  const detPersonality =
    personality ||
    (Array.isArray(brandBrief?.tone)
      ? brandBrief!.tone!.join(", ")
      : (brandBrief?.tone ?? "").trim()) ||
    todoCallout("PERSONALITY", "set personality or tone in 03_brand/brand-kit/brand-brief.json");

  const detPositioning =
    positioning ||
    todoCallout("POSITIONING", "set positioning in brand-brief.json");

  const detPromise =
    promise ||
    brandBrief?.mission?.trim() ||
    todoCallout("PROMISE", "set promise or mission in brand-brief.json");

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    PERSONALITY: detPersonality,
    POSITIONING: detPositioning,
    PROMISE: detPromise,
    CURRENT_DATE: isoDate(ctx.now()),
  };

  let usedLlm = false;
  if (ctx.callLlm && brandBrief) {
    try {
      const synth = await callLlmStrict(ctx.callLlm, {
        system: `Write a 1-paragraph BRAND PROMISE for "${ctx.ventureName}". Plain prose, ~60-100 words. Cite the user benefit.`,
        user: `Brand brief excerpt:\n${JSON.stringify({ mission: brandBrief.mission, positioning: brandBrief.positioning, promise: brandBrief.promise, tone: brandBrief.tone }, null, 2)}`,
      });
      placeholders.PROMISE = synth;
      usedLlm = true;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notes.push(`brand-strategy: LLM failed -- using deterministic: ${m}`);
    }
  }

  return mkResult("brand-strategy", placeholders, sourcesRead, usedLlm, notes);
};

// ---------------------------------------------------------------------------
// logo-pack
// ---------------------------------------------------------------------------

export const createLogoPackStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const exportsDir = getLogoExportsDir(ctx.ventureRoot);
  const entries = await readDirIfExists(exportsDir);
  if (entries.length > 0) sourcesRead.push("03_brand/logo/exports/");

  const variants = entries
    .filter((e) => /\.(svg|png|jpg|jpeg|webp)$/i.test(e))
    .sort();

  const primary = ctx.brandTokens.logoSvgPath || ctx.brandTokens.logoPngPath || ".brand/logo.svg";
  const variantsList = variants.length > 0
    ? bulletList(
        variants.map((v) => `\`03_brand/logo/exports/${v}\``),
        "no variants"
      )
    : todoCallout("LOGO_VARIANTS", "no exports in 03_brand/logo/exports/ -- run BRAND logo step");

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    LOGO_PRIMARY: primary,
    LOGO_VARIANTS: truncate(variantsList, 2000),
    CURRENT_DATE: isoDate(ctx.now()),
  };

  return mkResult("logo-pack", placeholders, sourcesRead, false, notes);
};

// ---------------------------------------------------------------------------
// design-handoff
// ---------------------------------------------------------------------------

export const createDesignHandoffStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const handoffExport = await readJsonIfExists<HandoffExportLike>(
    getHandoffExportPath(ctx.ventureRoot)
  );
  if (handoffExport) sourcesRead.push("06_product/stitch/handoff-export.json");

  const sliderLines: string[] = [];
  if (Array.isArray(handoffExport?.parameters)) {
    for (const p of handoffExport!.parameters!) {
      const key = (p.key ?? "").toString().trim() || "(unnamed)";
      const label = (p.label ?? "").toString().trim();
      const value = JSON.stringify(p.value ?? null);
      sliderLines.push(label ? `- **${key}** (${label}): ${value}` : `- **${key}**: ${value}`);
    }
  }
  const detSliders = sliderLines.length > 0
    ? sliderLines.join("\n")
    : todoCallout("SLIDERS", "no handoff-export.json -- run HANDOFF stage (CoDesign or Stitch)");

  const tokenLines: string[] = [];
  if (handoffExport?.tokens) {
    for (const [k, v] of Object.entries(handoffExport.tokens)) {
      tokenLines.push(`- \`${k}\`: ${JSON.stringify(v)}`);
      if (tokenLines.length >= 40) break;
    }
  }
  const detTokens = tokenLines.length > 0
    ? tokenLines.join("\n")
    : todoCallout("TOKENS", "no tokens in handoff-export.json");

  // Hash the HTML payload (or prompt if html absent) so the doc carries
  // a stable fingerprint pointing at a specific handoff revision.
  const htmlOrPrompt = handoffExport?.html ?? handoffExport?.prompt ?? "";
  const htmlHash = htmlOrPrompt.length > 0
    ? `\`${createHash("sha256").update(htmlOrPrompt).digest("hex").slice(0, 12)}\` (${htmlOrPrompt.length} chars)`
    : todoCallout("HTML_HASH", "handoff-export.json has neither html nor prompt");

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    SLIDERS: truncate(detSliders, 3000),
    TOKENS: truncate(detTokens, 3000),
    HTML_HASH: htmlHash,
    CURRENT_DATE: isoDate(ctx.now()),
  };

  return mkResult("design-handoff", placeholders, sourcesRead, false, notes);
};

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function mkResult(
  docId: string,
  placeholders: Record<string, string>,
  sourcesRead: string[],
  usedLlm: boolean,
  notes: string[]
): GoldenStepResult {
  return { docId, placeholders, sourcesRead, usedLlm, notes };
}
