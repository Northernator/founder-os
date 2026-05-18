/**
 * Slice 7 -- strategy-tier Tier-B steps (9 docs).
 *
 *   - business-plan          -- market / revenue / unit economics / team plan (LLM).
 *   - competitor-analysis    -- table from research competitors (pure render).
 *   - pricing-strategy       -- tier table from validation/finance (LLM).
 *   - business-model-canvas  -- canvas synthesis (LLM).
 *   - positioning-statement  -- 1-paragraph positioning (LLM).
 *   - value-proposition      -- 1-paragraph value prop (LLM).
 *   - strategic-roadmap      -- 3/6/12-month horizons (pure render).
 *   - unit-economics-model   -- CAC/LTV/churn/margins (pure render).
 *   - investor-deck          -- problem/solution/market/traction/team/ask (LLM).
 *
 * NODE-ONLY.
 */
import { join } from "node:path";
import {
  getBrandKitDir,
  getSpecCanvasPath,
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
} from "../golden/helpers.js";
import type { GoldenStep, GoldenStepResult } from "./types.js";

type BrandBriefLike = {
  mission?: string;
  positioning?: string;
  audience?: string;
  tone?: string | string[];
  values?: string[];
};
type ValidationCanvasLike = {
  icpDescription?: string;
  icpPain?: string;
  pricingTiers?: Array<{ name?: string; priceGbp?: number; features?: string[]; ceiling?: string }>;
};
type FinancePlanLike = {
  revenue?: {
    monthlyRecurringTargetGbp?: number;
    pricing?: Array<{ name?: string; priceGbp?: number; users?: number }>;
  };
  runway?: { monthsAtCurrentBurn?: number };
  unitEconomics?: { cacGbp?: number; ltvGbp?: number; churnPct?: number; grossMarginPct?: number };
};
type SpecCanvasLike = {
  productName?: string;
  features?: Array<{ name?: string; priority?: string; description?: string; horizon?: string }>;
};
type AuditLike = { findings?: Array<{ recommendation?: string; horizon?: string }> };
type ResearchSummaryLike = {
  marketSizeGbp?: string;
  marketSize?: string;
  trends?: string[];
  competitors?: Array<{ name?: string; pricing?: string; strengths?: string[]; weaknesses?: string[] }>;
};

async function loadBrandBrief(root: string): Promise<BrandBriefLike | null> {
  return readJsonIfExists<BrandBriefLike>(join(getBrandKitDir(root), "brand-brief.json"));
}
async function loadValidationCanvas(root: string): Promise<ValidationCanvasLike | null> {
  return readJsonIfExists<ValidationCanvasLike>(
    join(getStagePath(root, "validation"), "validation-canvas.json")
  );
}
async function loadFinancePlan(root: string): Promise<FinancePlanLike | null> {
  return readJsonIfExists<FinancePlanLike>(
    join(getStagePath(root, "finance"), "finance-plan.json")
  );
}

// ---------------------------------------------------------------------------
// business-plan
// ---------------------------------------------------------------------------

export const createBusinessPlanStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const brandBrief = await loadBrandBrief(ctx.ventureRoot);
  if (brandBrief) sourcesRead.push("03_brand/brand-kit/brand-brief.json");
  const validation = await loadValidationCanvas(ctx.ventureRoot);
  if (validation) sourcesRead.push("02_validation/validation-canvas.json");
  const finance = await loadFinancePlan(ctx.ventureRoot);
  if (finance) sourcesRead.push("05_finance/finance-plan.json");

  const researchDir = join(getStagePath(ctx.ventureRoot, "research"), "saas");
  const summaryMd = await readTextIfExists(join(researchDir, "business-summary.md"));
  if (summaryMd) sourcesRead.push("01_research/saas/business-summary.md");

  const detMarket =
    extractFirstSection(summaryMd ?? "", /##\s*(?:Market|Audience|Customers)\b[^\n]*\n/i) ||
    brandBrief?.audience?.trim() ||
    todoCallout("MARKET", "set audience in brand-brief or write 01_research/saas/business-summary.md");

  const detRevenue = finance?.revenue?.monthlyRecurringTargetGbp
    ? `Target MRR: £${finance.revenue.monthlyRecurringTargetGbp.toLocaleString("en-GB")}` +
        (Array.isArray(finance.revenue.pricing) && finance.revenue.pricing.length > 0
          ? `\n\nPricing tiers:\n${finance.revenue.pricing.map((p) => `- ${p.name ?? "?"}: £${p.priceGbp ?? "?"}/mo`).join("\n")}`
          : "")
    : todoCallout("REVENUE_MODEL", "set revenue.monthlyRecurringTargetGbp in finance-plan.json");

  const ue = finance?.unitEconomics;
  const detUnitEcon = ue
    ? bulletList(
        [
          ue.cacGbp !== undefined ? `CAC: £${ue.cacGbp}` : "",
          ue.ltvGbp !== undefined ? `LTV: £${ue.ltvGbp}` : "",
          ue.churnPct !== undefined ? `Churn: ${ue.churnPct}% / mo` : "",
          ue.grossMarginPct !== undefined ? `Gross margin: ${ue.grossMarginPct}%` : "",
        ],
        todoCallout("UNIT_ECONOMICS", "finance-plan has no unitEconomics block")
      )
    : todoCallout("UNIT_ECONOMICS", "set unitEconomics in finance-plan.json");

  const detTeam = todoCallout("TEAM_PLAN", "founder fills hiring plan (slice-7 has no org-chart source)");

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    MARKET: truncate(detMarket, 1500),
    REVENUE_MODEL: truncate(detRevenue, 1500),
    UNIT_ECONOMICS: truncate(detUnitEcon, 1200),
    TEAM_PLAN: detTeam,
    CURRENT_DATE: isoDate(ctx.now()),
  };

  let usedLlm = false;
  if (ctx.callLlm && (brandBrief || validation || finance)) {
    try {
      const synth = await callLlmStrict(ctx.callLlm, {
        system: `Write the MARKET section of a 1-page business plan for "${ctx.ventureName}". 2 short paragraphs, ~150-220 words. UK context. No bullets.`,
        user: `Brand brief: ${JSON.stringify({ mission: brandBrief?.mission, audience: brandBrief?.audience })}\nValidation ICP: ${validation?.icpDescription ?? "(none)"}\nResearch summary excerpt: ${truncate(summaryMd ?? "(none)", 1200)}`,
      });
      placeholders.MARKET = synth;
      usedLlm = true;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notes.push(`business-plan: LLM failed -- using deterministic market: ${m}`);
    }
  }

  return mkResult("business-plan", placeholders, sourcesRead, usedLlm, notes);
};

// ---------------------------------------------------------------------------
// competitor-analysis
// ---------------------------------------------------------------------------

export const createCompetitorAnalysisStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const researchDir = join(getStagePath(ctx.ventureRoot, "research"), "saas");
  const summaryJson = await readJsonIfExists<ResearchSummaryLike>(
    join(researchDir, "research-summary.json")
  );
  if (summaryJson) sourcesRead.push("01_research/saas/research-summary.json");

  const competitorsMd = await readMarkdownFiles(join(researchDir, "competitors"), { limit: 12 });
  for (const c of competitorsMd) sourcesRead.push(`01_research/saas/competitors/${c.filename}`);

  const competitorsList = Array.isArray(summaryJson?.competitors) ? summaryJson!.competitors! : [];
  const lines: string[] = [];

  if (competitorsList.length > 0) {
    lines.push("| Name | Pricing | Strengths | Weaknesses |");
    lines.push("|---|---|---|---|");
    for (const c of competitorsList.slice(0, 20)) {
      const name = (c.name ?? "?").replace(/\|/g, "\\|");
      const pricing = (c.pricing ?? "?").replace(/\|/g, "\\|");
      const strengths = Array.isArray(c.strengths) ? c.strengths.join(", ").replace(/\|/g, "\\|") : "-";
      const weaknesses = Array.isArray(c.weaknesses) ? c.weaknesses.join(", ").replace(/\|/g, "\\|") : "-";
      lines.push(`| ${name} | ${pricing} | ${strengths} | ${weaknesses} |`);
    }
  } else if (competitorsMd.length > 0) {
    for (const m of competitorsMd) {
      lines.push(`### ${m.filename.replace(/\.md$/, "")}`);
      lines.push("");
      lines.push(truncate(m.content, 600));
      lines.push("");
    }
  } else {
    lines.push(todoCallout("COMPETITORS", "no competitor data -- run RESEARCH stage's competitors step"));
  }

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    COMPETITORS: truncate(lines.join("\n"), 8000),
    CURRENT_DATE: isoDate(ctx.now()),
  };

  return mkResult("competitor-analysis", placeholders, sourcesRead, false, notes);
};

// ---------------------------------------------------------------------------
// pricing-strategy
// ---------------------------------------------------------------------------

export const createPricingStrategyStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const validation = await loadValidationCanvas(ctx.ventureRoot);
  if (validation) sourcesRead.push("02_validation/validation-canvas.json");
  const finance = await loadFinancePlan(ctx.ventureRoot);
  if (finance) sourcesRead.push("05_finance/finance-plan.json");

  const tiers = Array.isArray(validation?.pricingTiers) ? validation!.pricingTiers! : [];
  const fallbackPricing = Array.isArray(finance?.revenue?.pricing) ? finance!.revenue!.pricing! : [];

  const lines: string[] = [];
  if (tiers.length > 0) {
    lines.push("| Tier | Price (GBP/mo) | Ceiling | Features |");
    lines.push("|---|--:|---|---|");
    for (const t of tiers) {
      const features = Array.isArray(t.features) ? t.features.join("; ") : "-";
      lines.push(`| ${t.name ?? "?"} | ${t.priceGbp ?? "?"} | ${t.ceiling ?? "-"} | ${features} |`);
    }
  } else if (fallbackPricing.length > 0) {
    lines.push("| Tier | Price (GBP/mo) | Target users |");
    lines.push("|---|--:|--:|");
    for (const p of fallbackPricing) {
      lines.push(`| ${p.name ?? "?"} | ${p.priceGbp ?? "?"} | ${p.users ?? "?"} |`);
    }
  } else {
    lines.push(todoCallout("PRICING_TIERS", "no pricing in validation-canvas or finance-plan"));
  }

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    PRICING_TIERS: truncate(lines.join("\n"), 4000),
    CURRENT_DATE: isoDate(ctx.now()),
  };

  let usedLlm = false;
  if (ctx.callLlm && (tiers.length > 0 || fallbackPricing.length > 0)) {
    try {
      const synth = await callLlmStrict(ctx.callLlm, {
        system: `Write the PRICING STRATEGY rationale for "${ctx.ventureName}". 2 short paragraphs after a markdown table. ~120-200 words. Justify positioning vs competitors / customer value.`,
        user: `Validation pricing tiers:\n${JSON.stringify(tiers, null, 2)}\nFinance pricing:\n${JSON.stringify(fallbackPricing, null, 2)}`,
      });
      // Append the LLM rationale below the table.
      placeholders.PRICING_TIERS = truncate(`${lines.join("\n")}\n\n${synth}`, 5000);
      usedLlm = true;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notes.push(`pricing-strategy: LLM failed -- using deterministic table: ${m}`);
    }
  }

  return mkResult("pricing-strategy", placeholders, sourcesRead, usedLlm, notes);
};

// ---------------------------------------------------------------------------
// business-model-canvas
// ---------------------------------------------------------------------------

export const createBusinessModelCanvasStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const brandBrief = await loadBrandBrief(ctx.ventureRoot);
  if (brandBrief) sourcesRead.push("03_brand/brand-kit/brand-brief.json");
  const validation = await loadValidationCanvas(ctx.ventureRoot);
  if (validation) sourcesRead.push("02_validation/validation-canvas.json");

  const blocks: Record<string, string> = {
    "Customer Segments": validation?.icpDescription?.trim() || brandBrief?.audience?.trim() || "",
    "Value Propositions": brandBrief?.mission?.trim() || "",
    "Channels": "",
    "Customer Relationships": "",
    "Revenue Streams": Array.isArray(validation?.pricingTiers) && validation!.pricingTiers!.length > 0
      ? validation!.pricingTiers!.map((t) => t.name ?? "").filter(Boolean).join(", ")
      : "",
    "Key Activities": "",
    "Key Resources": "",
    "Key Partnerships": "",
    "Cost Structure": "",
  };

  const lines: string[] = [];
  for (const [k, v] of Object.entries(blocks)) {
    lines.push(`### ${k}`);
    lines.push(v.length > 0 ? v : todoCallout(k.toUpperCase().replace(/\s+/g, "_"), "founder fills"));
    lines.push("");
  }

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    CANVAS: truncate(lines.join("\n"), 5000),
    CURRENT_DATE: isoDate(ctx.now()),
  };

  let usedLlm = false;
  if (ctx.callLlm && (brandBrief || validation)) {
    try {
      const synth = await callLlmStrict(ctx.callLlm, {
        system: `Fill the BUSINESS MODEL CANVAS for "${ctx.ventureName}" -- markdown with H3 per of the 9 blocks. Short, factual bullets per block. ~250-400 words total.`,
        user: `Brand: ${JSON.stringify({ mission: brandBrief?.mission, audience: brandBrief?.audience })}\nValidation: ${JSON.stringify({ icp: validation?.icpDescription, pain: validation?.icpPain, pricing: validation?.pricingTiers })}`,
      });
      placeholders.CANVAS = truncate(synth, 5000);
      usedLlm = true;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notes.push(`business-model-canvas: LLM failed -- using deterministic: ${m}`);
    }
  }

  return mkResult("business-model-canvas", placeholders, sourcesRead, usedLlm, notes);
};

// ---------------------------------------------------------------------------
// positioning-statement
// ---------------------------------------------------------------------------

export const createPositioningStatementStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const brandBrief = await loadBrandBrief(ctx.ventureRoot);
  if (brandBrief) sourcesRead.push("03_brand/brand-kit/brand-brief.json");
  const validation = await loadValidationCanvas(ctx.ventureRoot);
  if (validation) sourcesRead.push("02_validation/validation-canvas.json");

  const det =
    brandBrief?.positioning?.trim() ||
    [brandBrief?.audience, brandBrief?.mission].filter(Boolean).join(" -- ").trim() ||
    todoCallout("POSITIONING", "set positioning in 03_brand/brand-kit/brand-brief.json");

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    POSITIONING: truncate(det, 1500),
    CURRENT_DATE: isoDate(ctx.now()),
  };

  let usedLlm = false;
  if (ctx.callLlm && brandBrief) {
    try {
      const synth = await callLlmStrict(ctx.callLlm, {
        system: `Write a POSITIONING STATEMENT for "${ctx.ventureName}" in the classic "For [audience], [product] is the [category] that [benefit] unlike [alternative]" structure. ~60-100 words. Plain prose.`,
        user: `Audience: ${brandBrief.audience ?? "(none)"}\nMission: ${brandBrief.mission ?? "(none)"}\nICP pain: ${validation?.icpPain ?? "(none)"}`,
      });
      placeholders.POSITIONING = synth;
      usedLlm = true;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notes.push(`positioning-statement: LLM failed -- using deterministic: ${m}`);
    }
  }

  return mkResult("positioning-statement", placeholders, sourcesRead, usedLlm, notes);
};

// ---------------------------------------------------------------------------
// value-proposition
// ---------------------------------------------------------------------------

export const createValuePropositionStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const brandBrief = await loadBrandBrief(ctx.ventureRoot);
  if (brandBrief) sourcesRead.push("03_brand/brand-kit/brand-brief.json");
  const validation = await loadValidationCanvas(ctx.ventureRoot);
  if (validation) sourcesRead.push("02_validation/validation-canvas.json");

  const props: string[] = [];
  if (brandBrief?.mission) props.push(brandBrief.mission.trim());
  if (validation?.icpPain) props.push(`Eliminates: ${validation.icpPain.trim()}`);
  if (Array.isArray(brandBrief?.values)) {
    for (const v of brandBrief!.values!.slice(0, 5)) props.push(v);
  }

  const det = props.length > 0
    ? bulletList(props, todoCallout("VALUE_PROPS", "no brand-brief mission / validation pain captured"))
    : todoCallout("VALUE_PROPS", "set mission in brand-brief and pain in validation-canvas");

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    VALUE_PROPS: truncate(det, 2500),
    CURRENT_DATE: isoDate(ctx.now()),
  };

  let usedLlm = false;
  if (ctx.callLlm && (brandBrief || validation)) {
    try {
      const synth = await callLlmStrict(ctx.callLlm, {
        system: `Write a VALUE PROPOSITION block for "${ctx.ventureName}" -- 1 short paragraph followed by a 3-4 line markdown bullet list of concrete user benefits. ~120-180 words.`,
        user: `Mission: ${brandBrief?.mission ?? "(none)"}\nPain: ${validation?.icpPain ?? "(none)"}\nValues: ${JSON.stringify(brandBrief?.values ?? [])}`,
      });
      placeholders.VALUE_PROPS = truncate(synth, 2500);
      usedLlm = true;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notes.push(`value-proposition: LLM failed -- using deterministic: ${m}`);
    }
  }

  return mkResult("value-proposition", placeholders, sourcesRead, usedLlm, notes);
};

// ---------------------------------------------------------------------------
// strategic-roadmap
// ---------------------------------------------------------------------------

export const createStrategicRoadmapStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const canvas = await readJsonIfExists<SpecCanvasLike>(getSpecCanvasPath(ctx.ventureRoot));
  if (canvas) sourcesRead.push("06_product/specs/spec-canvas.json");

  const audit = await readJsonIfExists<AuditLike>(
    join(getStagePath(ctx.ventureRoot, "build"), "audits", "audit.json")
  );
  if (audit) sourcesRead.push("07_build/audits/audit.json");

  const features = Array.isArray(canvas?.features) ? canvas!.features! : [];
  const bucket = (filter: (f: { priority?: string; horizon?: string }) => boolean): string[] =>
    features
      .filter(filter)
      .map((f) => f.name?.trim() ?? "")
      .filter((n) => n.length > 0);

  const m3 = bucket((f) => (f.horizon ?? "").includes("3") || f.priority === "P0");
  const m6 = bucket((f) => (f.horizon ?? "").includes("6") || f.priority === "P1");
  const m12 = bucket((f) => !((f.horizon ?? "").includes("3") || (f.horizon ?? "").includes("6") || f.priority === "P0" || f.priority === "P1"));

  const sections: string[] = [];
  sections.push("### 3 months");
  sections.push(bulletList(m3, todoCallout("3M", "no P0 features in spec-canvas")));
  sections.push("");
  sections.push("### 6 months");
  sections.push(bulletList(m6, todoCallout("6M", "no P1 features in spec-canvas")));
  sections.push("");
  sections.push("### 12 months");
  sections.push(bulletList(m12, todoCallout("12M", "no later-horizon features captured")));

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    HORIZONS: truncate(sections.join("\n"), 5000),
    CURRENT_DATE: isoDate(ctx.now()),
  };

  return mkResult("strategic-roadmap", placeholders, sourcesRead, false, notes);
};

// ---------------------------------------------------------------------------
// unit-economics-model
// ---------------------------------------------------------------------------

export const createUnitEconomicsModelStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const finance = await loadFinancePlan(ctx.ventureRoot);
  if (finance) sourcesRead.push("05_finance/finance-plan.json");

  const ue = finance?.unitEconomics ?? {};
  const fmtGbp = (n: number | undefined): string => (typeof n === "number" ? `£${n.toLocaleString("en-GB")}` : "TBD");
  const fmtPct = (n: number | undefined): string => (typeof n === "number" ? `${n}%` : "TBD");

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    CAC: fmtGbp(ue.cacGbp),
    LTV: fmtGbp(ue.ltvGbp),
    CHURN: fmtPct(ue.churnPct),
    MARGINS: fmtPct(ue.grossMarginPct),
    CURRENT_DATE: isoDate(ctx.now()),
  };

  if (typeof ue.cacGbp !== "number" || typeof ue.ltvGbp !== "number") {
    notes.push("unit-economics-model: finance-plan.unitEconomics incomplete -- doc shows TBD placeholders");
  }

  return mkResult("unit-economics-model", placeholders, sourcesRead, false, notes);
};

// ---------------------------------------------------------------------------
// investor-deck
// ---------------------------------------------------------------------------

export const createInvestorDeckStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const brandBrief = await loadBrandBrief(ctx.ventureRoot);
  if (brandBrief) sourcesRead.push("03_brand/brand-kit/brand-brief.json");
  const validation = await loadValidationCanvas(ctx.ventureRoot);
  if (validation) sourcesRead.push("02_validation/validation-canvas.json");
  const finance = await loadFinancePlan(ctx.ventureRoot);
  if (finance) sourcesRead.push("05_finance/finance-plan.json");

  const researchDir = join(getStagePath(ctx.ventureRoot, "research"), "saas");
  const summary = await readTextIfExists(join(researchDir, "business-summary.md"));
  if (summary) sourcesRead.push("01_research/saas/business-summary.md");

  const detProblem = validation?.icpPain?.trim() || todoCallout("PROBLEM", "set icpPain in validation-canvas");
  const detSolution = brandBrief?.mission?.trim() || todoCallout("SOLUTION", "set mission in brand-brief");
  const detMarket = brandBrief?.audience?.trim() || todoCallout("MARKET", "set audience in brand-brief");
  const detTraction = todoCallout("TRACTION", "founder fills (slice-7 has no metrics source)");
  const detTeam = todoCallout("TEAM", "founder fills (slice-7 has no org-chart source)");

  const mrr = finance?.revenue?.monthlyRecurringTargetGbp;
  const runway = finance?.runway?.monthsAtCurrentBurn;
  const askParts: string[] = [];
  if (typeof mrr === "number") askParts.push(`Target MRR: £${mrr.toLocaleString("en-GB")}`);
  if (typeof runway === "number") askParts.push(`Current runway: ${runway} months`);
  const detAsk = askParts.length > 0
    ? bulletList(askParts, "")
    : todoCallout("ASK", "founder fills (raise amount, valuation, use of funds)");

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    PROBLEM: truncate(detProblem, 1200),
    SOLUTION: truncate(detSolution, 1200),
    MARKET: truncate(detMarket, 1200),
    TRACTION: detTraction,
    TEAM: detTeam,
    ASK: truncate(detAsk, 1200),
    CURRENT_DATE: isoDate(ctx.now()),
  };

  let usedLlm = false;
  if (ctx.callLlm && (brandBrief || validation || finance)) {
    try {
      const synth = await callLlmStrict(ctx.callLlm, {
        system: `Write the SOLUTION slide narrative for "${ctx.ventureName}"'s investor deck. 1 short paragraph. ~80-130 words. Crisp.`,
        user: `Mission: ${brandBrief?.mission ?? "(none)"}\nICP pain: ${validation?.icpPain ?? "(none)"}\nResearch excerpt: ${truncate(summary ?? "(none)", 1000)}`,
      });
      placeholders.SOLUTION = truncate(synth, 1500);
      usedLlm = true;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notes.push(`investor-deck: LLM failed -- using deterministic solution: ${m}`);
    }
  }

  return mkResult("investor-deck", placeholders, sourcesRead, usedLlm, notes);
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
