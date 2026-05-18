/**
 * Slice 7 -- company-control-tier Tier-B steps.
 *
 * Two docs:
 *   - founder-vision  -- founder's long-term vision, values, non-negotiables.
 *   - risk-register   -- legal / product / financial / security / market /
 *                        operational / people risks across the venture.
 *
 * NODE-ONLY.
 *
 * Both steps optionally call the LLM. Deterministic fallback for both:
 *   - founder-vision  -- pull mission/values from brand-brief if present,
 *                        else emit TODO callouts.
 *   - risk-register   -- aggregate audit findings + finance risks + research
 *                        gaps into a categorised list; if nothing exists, emit
 *                        an empty per-category template.
 */
import { join } from "node:path";
import {
  getBrandKitDir,
  getStagePath,
} from "@founder-os/workspace-core";
import {
  bulletList,
  callLlmStrict,
  isoDate,
  readJsonIfExists,
  readMarkdownFiles,
  readTextIfExists,
  todoCallout,
  truncate,
} from "../golden/helpers.js";
import type { GoldenStep, GoldenStepResult } from "./types.js";

// ---------------------------------------------------------------------------
// founder-vision
// ---------------------------------------------------------------------------

type BrandBriefLike = {
  mission?: string;
  vision?: string;
  values?: string[];
  audience?: string;
  founderName?: string;
};

type VentureManifestLike = {
  founder?: string;
  founderName?: string;
  owner?: string;
};

export const createFounderVisionStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const brandPath = join(getBrandKitDir(ctx.ventureRoot), "brand-brief.json");
  const brandBrief = await readJsonIfExists<BrandBriefLike>(brandPath);
  if (brandBrief) sourcesRead.push("03_brand/brand-kit/brand-brief.json");

  const manifestPath = join(ctx.ventureRoot, "venture.yaml");
  const manifestRaw = await readTextIfExists(manifestPath);
  if (manifestRaw) sourcesRead.push("venture.yaml");
  const founderName =
    brandBrief?.founderName?.trim() ||
    extractYamlField(manifestRaw, "founder") ||
    extractYamlField(manifestRaw, "founderName") ||
    extractYamlField(manifestRaw, "owner") ||
    todoCallout("FOUNDER_NAME", "set founder/owner in venture.yaml");

  const visionDeterministic =
    brandBrief?.vision?.trim() ||
    brandBrief?.mission?.trim() ||
    todoCallout("VISION", "fill vision in 03_brand/brand-kit/brand-brief.json");

  const valuesList = Array.isArray(brandBrief?.values) ? brandBrief!.values! : [];
  const valuesDeterministic = bulletList(
    valuesList,
    todoCallout("VALUES", "add values[] to brand-brief.json")
  );

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    FOUNDER_NAME: founderName,
    VISION: visionDeterministic,
    VALUES: valuesDeterministic,
    CURRENT_DATE: isoDate(ctx.now()),
  };

  let usedLlm = false;
  if (ctx.callLlm && brandBrief) {
    try {
      const synth = await callLlmStrict(ctx.callLlm, {
        system: `Write a 1-2 paragraph founder VISION statement for the SaaS venture "${ctx.ventureName}". Plain prose, ~100-180 words. UK context.`,
        user: `Brand brief excerpt:\n${JSON.stringify({ mission: brandBrief.mission, vision: brandBrief.vision, audience: brandBrief.audience }, null, 2)}`,
      });
      placeholders.VISION = synth;
      usedLlm = true;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notes.push(`founder-vision: LLM failed -- using deterministic: ${m}`);
    }
  }

  return mkResult("founder-vision", placeholders, sourcesRead, usedLlm, notes);
};

// ---------------------------------------------------------------------------
// risk-register
// ---------------------------------------------------------------------------

type AuditLike = {
  findings?: Array<{ id?: string; category?: string; severity?: string; recommendation?: string; summary?: string }>;
};

type FinancePlanLike = {
  risks?: string[];
  runway?: { monthsAtCurrentBurn?: number };
};

export const createRiskRegisterStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const auditPath = join(getStagePath(ctx.ventureRoot, "build"), "audits", "audit.json");
  const audit = await readJsonIfExists<AuditLike>(auditPath);
  if (audit) sourcesRead.push("07_build/audits/audit.json");

  const financePath = join(getStagePath(ctx.ventureRoot, "finance"), "finance-plan.json");
  const finance = await readJsonIfExists<FinancePlanLike>(financePath);
  if (finance) sourcesRead.push("05_finance/finance-plan.json");

  const researchDir = join(getStagePath(ctx.ventureRoot, "research"), "saas");
  const researchFiles = await readMarkdownFiles(researchDir, { limit: 3 });
  for (const r of researchFiles) sourcesRead.push(`01_research/saas/${r.filename}`);

  // Group findings by audit category, fall back to TODO callouts.
  const categories: Record<string, string[]> = {
    Legal: [],
    Product: [],
    Financial: [],
    Security: [],
    Market: [],
    Operational: [],
    People: [],
  };
  if (audit?.findings) {
    for (const f of audit.findings) {
      const cat = mapCategory(f.category);
      const text = (f.summary ?? f.recommendation ?? "").trim();
      if (text.length > 0) categories[cat]?.push(text);
    }
  }
  if (Array.isArray(finance?.risks)) {
    for (const r of finance!.risks!) categories["Financial"]?.push(r);
  }
  if (typeof finance?.runway?.monthsAtCurrentBurn === "number" && finance.runway.monthsAtCurrentBurn < 6) {
    categories["Financial"]?.push(`Runway under 6 months (${finance.runway.monthsAtCurrentBurn}mo) -- raise or cut burn`);
  }

  const lines: string[] = [];
  for (const [cat, items] of Object.entries(categories)) {
    lines.push(`### ${cat}`);
    if (items.length === 0) {
      lines.push(todoCallout(cat.toUpperCase(), "no entries from pipeline; founder fills"));
    } else {
      lines.push(...items.map((i) => `- ${i}`));
    }
    lines.push("");
  }

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    RISKS_BY_CATEGORY: truncate(lines.join("\n"), 6000),
    CURRENT_DATE: isoDate(ctx.now()),
  };

  let usedLlm = false;
  const hasMaterial = (audit?.findings?.length ?? 0) > 0 || (finance?.risks?.length ?? 0) > 0;
  if (ctx.callLlm && hasMaterial) {
    try {
      const synth = await callLlmStrict(ctx.callLlm, {
        system: `You are writing a RISK REGISTER for the SaaS venture "${ctx.ventureName}". Output markdown with one H3 per category (Legal, Product, Financial, Security, Market, Operational, People) and bulleted risks under each. ~250-500 words.`,
        user: `Audit findings: ${JSON.stringify(audit?.findings?.slice(0, 30) ?? [])}\nFinance risks: ${JSON.stringify(finance?.risks ?? [])}\nRunway: ${finance?.runway?.monthsAtCurrentBurn ?? "unknown"} months`,
      });
      placeholders.RISKS_BY_CATEGORY = truncate(synth, 6000);
      usedLlm = true;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notes.push(`risk-register: LLM failed -- using deterministic: ${m}`);
    }
  }

  return mkResult("risk-register", placeholders, sourcesRead, usedLlm, notes);
};

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function mapCategory(cat: string | undefined): string {
  const k = (cat ?? "").toLowerCase();
  if (k.includes("legal") || k.includes("compliance") || k.includes("privacy")) return "Legal";
  if (k.includes("financial") || k.includes("money") || k.includes("burn")) return "Financial";
  if (k.includes("security") || k.includes("auth")) return "Security";
  if (k.includes("market") || k.includes("competitor")) return "Market";
  if (k.includes("ops") || k.includes("operational") || k.includes("infra")) return "Operational";
  if (k.includes("people") || k.includes("hr") || k.includes("hiring")) return "People";
  return "Product";
}

function extractYamlField(raw: string | null, field: string): string {
  if (!raw) return "";
  const re = new RegExp(`^${field}:\\s*(.+)$`, "m");
  const m = raw.match(re);
  return m ? m[1]!.trim().replace(/^["']|["']$/g, "") : "";
}

function mkResult(
  docId: string,
  placeholders: Record<string, string>,
  sourcesRead: string[],
  usedLlm: boolean,
  notes: string[]
): GoldenStepResult {
  return { docId, placeholders, sourcesRead, usedLlm, notes };
}
