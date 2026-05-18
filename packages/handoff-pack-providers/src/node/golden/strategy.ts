/**
 * Slice 6 -- strategy-tier Golden steps.
 *
 * Three docs:
 *   - company-brief    -- one-page synthesis of research + brand.
 *   - market-research  -- market size / trends / pain / opportunity.
 *   - icp-personas     -- ideal customer profile + buyer personas.
 *
 * NODE-ONLY. Each step:
 *   1. Reads its declared prior-stage artefacts (best-effort).
 *   2. Computes deterministic placeholder values + TODO callouts.
 *   3. If callLlm is supplied, replaces high-value narrative slots
 *      with an LLM-generated paragraph. LLM failures fall back to
 *      deterministic content and surface a note.
 *   4. Returns a GoldenStepResult the dispatcher merges into the
 *      contextOverrides record renderAllStubsStep consumes.
 */
import { join } from "node:path";
import {
  getBrandKitDir,
  getStagePath,
} from "@founder-os/workspace-core";
import {
  bulletList,
  callLlmStrict,
  extractFirstSection,
  isoDate,
  readJsonIfExists,
  readMarkdownFiles,
  readTextIfExists,
  todoCallout,
  truncate,
} from "./helpers.js";
import type {
  GoldenStep,
  GoldenStepContext,
  GoldenStepResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Shared brand-brief shape (best-effort -- we don't hard-import the BRAND
// stage's schema to keep this package decoupled from pipeline-runner).
// ---------------------------------------------------------------------------

type BrandBriefLike = {
  mission?: string;
  vision?: string;
  positioning?: string;
  audience?: string;
  tone?: string | string[];
  productSummary?: string;
  businessModel?: string;
  values?: string[];
  colorPalette?: {
    primary?: string;
    secondary?: string;
    background?: string;
    text?: string;
  };
  typography?: {
    headingFont?: string;
    bodyFont?: string;
    monoFont?: string;
  };
};

async function loadBrandBrief(ventureRoot: string): Promise<BrandBriefLike | null> {
  const path = join(getBrandKitDir(ventureRoot), "brand-brief.json");
  return readJsonIfExists<BrandBriefLike>(path);
}

// ---------------------------------------------------------------------------
// company-brief
// ---------------------------------------------------------------------------

export const createCompanyBriefStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const brandBrief = await loadBrandBrief(ctx.ventureRoot);
  if (brandBrief) sourcesRead.push("03_brand/brand-kit/brand-brief.json");

  const researchDir = join(getStagePath(ctx.ventureRoot, "research"), "saas");
  const researchFiles = await readMarkdownFiles(researchDir, { limit: 4 });
  for (const r of researchFiles) sourcesRead.push(`01_research/saas/${r.filename}`);

  const businessSummaryMd = await readTextIfExists(
    join(researchDir, "business-summary.md")
  );

  // Deterministic defaults.
  const mission = (brandBrief?.mission ?? "").trim();
  const positioning = (brandBrief?.positioning ?? "").trim();
  const audience = (brandBrief?.audience ?? "").trim();
  const productSummary = (brandBrief?.productSummary ?? "").trim();
  const businessModel = (brandBrief?.businessModel ?? "").trim();

  const deterministicTargetMarket = audience
    || extractFirstSection(
      businessSummaryMd ?? "",
      /##\s*(?:Target market|Audience|ICP)\b[^\n]*\n/i
    )
    || todoCallout("TARGET_MARKET", "no audience block in brand-brief or 01_research/saas/business-summary.md");

  const deterministicProductSummary = productSummary
    || extractFirstSection(
      businessSummaryMd ?? "",
      /##\s*(?:Product summary|Product|Offer)\b[^\n]*\n/i
    )
    || todoCallout("PRODUCT_SUMMARY", "no product summary captured yet");

  const deterministicBusinessModel = businessModel
    || extractFirstSection(
      businessSummaryMd ?? "",
      /##\s*(?:Business model|Monetization|Pricing model)\b[^\n]*\n/i
    )
    || todoCallout("BUSINESS_MODEL", "capture pricing model in 03_brand or 01_research");

  const deterministicMission = mission
    || positioning
    || todoCallout("MISSION", "set mission in 03_brand/brand-kit/brand-brief.json");

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    COMPANY_SLUG: ctx.ventureSlug,
    CURRENT_DATE: isoDate(ctx.now()),
    MISSION: deterministicMission,
    TARGET_MARKET: truncate(deterministicTargetMarket, 1200),
    PRODUCT_SUMMARY: truncate(deterministicProductSummary, 1200),
    BUSINESS_MODEL: truncate(deterministicBusinessModel, 800),
  };

  let usedLlm = false;
  if (ctx.callLlm) {
    try {
      const researchBlock = researchFiles
        .map((r) => `### ${r.filename}\n\n${truncate(r.content, 1500)}`)
        .join("\n\n");
      const narrative = await callLlmStrict(ctx.callLlm, {
        system: `You are writing a one-paragraph COMPANY MISSION for the SaaS venture "${ctx.ventureName}". Output 1 short paragraph of plain prose (no bullets, no markdown). Be specific to the venture. ~80-120 words. UK context.`,
        user: `Brand brief excerpt:\n${JSON.stringify({
          mission: brandBrief?.mission,
          positioning: brandBrief?.positioning,
          audience: brandBrief?.audience,
          tone: brandBrief?.tone,
        }, null, 2)}\n\nResearch excerpts:\n${researchBlock || "(none)"}`,
      });
      placeholders.MISSION = narrative;
      usedLlm = true;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notes.push(`company-brief: LLM failed -- using deterministic mission: ${m}`);
    }
  }

  return mkResult("company-brief", placeholders, sourcesRead, usedLlm, notes);
};

// ---------------------------------------------------------------------------
// market-research
// ---------------------------------------------------------------------------

export const createMarketResearchStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const researchDir = join(getStagePath(ctx.ventureRoot, "research"), "saas");
  const marketResearchMd = await readTextIfExists(join(researchDir, "market-research.md"));
  if (marketResearchMd) sourcesRead.push("01_research/saas/market-research.md");

  const marketGapsMd = await readTextIfExists(join(researchDir, "market-gaps.md"));
  if (marketGapsMd) sourcesRead.push("01_research/saas/market-gaps.md");

  const competitorsMd = await readTextIfExists(join(researchDir, "competitor-analysis.md"));
  if (competitorsMd) sourcesRead.push("01_research/saas/competitor-analysis.md");

  const detMarketSize = extractFirstSection(
    marketResearchMd ?? "",
    /##\s*(?:Market size|TAM|Market opportunity)\b[^\n]*\n/i
  ) ?? todoCallout("MARKET_SIZE", "no market-research.md or no Market size section");

  const detTrends = extractFirstSection(
    marketResearchMd ?? "",
    /##\s*(?:Trends|Market trends|Drivers)\b[^\n]*\n/i
  ) ?? todoCallout("TRENDS", "fill in 01_research/saas/market-research.md");

  const detPainPoints = extractFirstSection(
    (marketGapsMd ?? "") + "\n\n" + (marketResearchMd ?? ""),
    /##\s*(?:Pain points|Customer pain|Problems)\b[^\n]*\n/i
  ) ?? todoCallout("PAIN_POINTS", "no pain-point section in research outputs");

  const detOpportunity = extractFirstSection(
    marketGapsMd ?? "",
    /##\s*(?:Opportunity|Gap|Wedge)\b[^\n]*\n/i
  ) ?? todoCallout("OPPORTUNITY", "fill in 01_research/saas/market-gaps.md");

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    CURRENT_DATE: isoDate(ctx.now()),
    MARKET_SIZE: truncate(detMarketSize, 1000),
    TRENDS: truncate(detTrends, 1200),
    PAIN_POINTS: truncate(detPainPoints, 1200),
    OPPORTUNITY: truncate(detOpportunity, 1200),
  };

  let usedLlm = false;
  if (ctx.callLlm && marketResearchMd) {
    try {
      const opportunity = await callLlmStrict(ctx.callLlm, {
        system: `You are writing the OPPORTUNITY paragraph of a market research report for the SaaS venture "${ctx.ventureName}". Output 1-2 paragraphs of plain prose. Cite the wedge concretely. ~120-200 words. UK context.`,
        user: `Market research:\n${truncate(marketResearchMd, 3000)}\n\nMarket gaps:\n${truncate(marketGapsMd ?? "(none)", 1500)}`,
      });
      placeholders.OPPORTUNITY = opportunity;
      usedLlm = true;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notes.push(`market-research: LLM failed -- using deterministic: ${m}`);
    }
  }

  return mkResult("market-research", placeholders, sourcesRead, usedLlm, notes);
};

// ---------------------------------------------------------------------------
// icp-personas
// ---------------------------------------------------------------------------

export const createIcpPersonasStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  type ValidationSummaryLike = {
    icp?: { description?: string; role?: string; pain?: string };
  };
  type ValidationCanvasLike = {
    icpDescription?: string;
    icpRole?: string;
    icpPain?: string;
    icpCurrentSolution?: string;
    icpTrigger?: string;
  };

  const validationDir = getStagePath(ctx.ventureRoot, "validation");
  const summary = await readJsonIfExists<ValidationSummaryLike>(
    join(validationDir, "validation-summary.json")
  );
  if (summary) sourcesRead.push("02_validation/validation-summary.json");

  const canvas = await readJsonIfExists<ValidationCanvasLike>(
    join(validationDir, "validation-canvas.json")
  );
  if (canvas) sourcesRead.push("02_validation/validation-canvas.json");

  const segmentsDir = join(ctx.ventureRoot, "11_crm", "segments");
  const segmentsMd = await readMarkdownFiles(segmentsDir, { limit: 3 });
  for (const s of segmentsMd) sourcesRead.push(`11_crm/segments/${s.filename}`);

  const description = canvas?.icpDescription?.trim() || summary?.icp?.description?.trim() || "";
  const role = canvas?.icpRole?.trim() || summary?.icp?.role?.trim() || "";
  const pain = canvas?.icpPain?.trim() || summary?.icp?.pain?.trim() || "";
  const currentSolution = canvas?.icpCurrentSolution?.trim() || "";
  const trigger = canvas?.icpTrigger?.trim() || "";

  const icpLines: string[] = [];
  if (description) icpLines.push(`**Description:** ${description}`);
  if (role) icpLines.push(`**Decision-maker role:** ${role}`);
  if (pain) icpLines.push(`**Primary pain:** ${pain}`);
  if (currentSolution) icpLines.push(`**Current workaround:** ${currentSolution}`);
  if (trigger) icpLines.push(`**Buying trigger:** ${trigger}`);
  const detIcp = icpLines.length > 0
    ? icpLines.join("\n\n")
    : todoCallout("ICP", "fill ICP in 02_validation tab");

  const detPersonas = segmentsMd.length > 0
    ? segmentsMd
        .map((s) => `### ${s.filename.replace(/\.md$/, "")}\n\n${truncate(s.content, 800)}`)
        .join("\n\n")
    : bulletList(
        [
          role ? `Primary persona -- ${role} -- driven by: ${pain || "TBD"}` : "",
          "Influencer / blocker -- TODO: identify",
          "End-user -- TODO: identify",
        ],
        todoCallout("PERSONAS", "no CRM segments yet -- run CRM stage or fill manually")
      );

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    CURRENT_DATE: isoDate(ctx.now()),
    ICP: truncate(detIcp, 1400),
    PERSONAS: truncate(detPersonas, 2000),
  };

  let usedLlm = false;
  if (ctx.callLlm && (description || pain)) {
    try {
      const synth = await callLlmStrict(ctx.callLlm, {
        system: `You are writing the ICP section of a buyer-persona pack for the SaaS venture "${ctx.ventureName}". Output 2-3 paragraphs of plain prose summarising the ideal customer (description, role, pain, trigger, current solution). No bullets, no markdown headings. ~150-250 words.`,
        user: `ICP canvas:\n${JSON.stringify({ description, role, pain, currentSolution, trigger }, null, 2)}`,
      });
      placeholders.ICP = synth;
      usedLlm = true;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notes.push(`icp-personas: LLM failed -- using deterministic: ${m}`);
    }
  }

  return mkResult("icp-personas", placeholders, sourcesRead, usedLlm, notes);
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

// Re-export ctx type for siblings that import this module.
export type { GoldenStepContext };
