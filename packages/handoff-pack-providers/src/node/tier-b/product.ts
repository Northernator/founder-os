/**
 * Slice 7 -- product-tier Tier-B steps.
 *
 * Three docs:
 *   - product-vision   -- 1-2 paragraph long-term product direction.
 *   - user-flows       -- per-screen flow extract from wireframes.
 *   - product-roadmap  -- 3/6/12-month roadmap from spec-canvas + audit.
 *
 * NODE-ONLY. product-vision is LLM-enabled; the other two are pure
 * renders (LLM would hallucinate screens / horizons).
 */
import { join } from "node:path";
import {
  getBrandKitDir,
  getScreensMarkdownPath,
  getSpecCanvasPath,
  getStagePath,
  getWireframesDir,
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

type BrandBriefLike = {
  mission?: string;
  productSummary?: string;
  audience?: string;
};

type SpecCanvasLike = {
  productName?: string;
  mission?: string;
  features?: Array<{ name?: string; priority?: string; description?: string; horizon?: string }>;
};

type AuditLike = {
  findings?: Array<{ category?: string; recommendation?: string; horizon?: string }>;
};

// ---------------------------------------------------------------------------
// product-vision
// ---------------------------------------------------------------------------

export const createProductVisionStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const canvas = await readJsonIfExists<SpecCanvasLike>(getSpecCanvasPath(ctx.ventureRoot));
  if (canvas) sourcesRead.push("06_product/specs/spec-canvas.json");

  const brandBrief = await readJsonIfExists<BrandBriefLike>(
    join(getBrandKitDir(ctx.ventureRoot), "brand-brief.json")
  );
  if (brandBrief) sourcesRead.push("03_brand/brand-kit/brand-brief.json");

  const productName = canvas?.productName?.trim() || ctx.ventureName;
  const detVision =
    canvas?.mission?.trim() ||
    brandBrief?.mission?.trim() ||
    brandBrief?.productSummary?.trim() ||
    todoCallout("VISION", "set mission in 06_product/specs/spec-canvas.json or 03_brand/brand-kit/brand-brief.json");

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    PRODUCT_NAME: productName,
    VISION: detVision,
    CURRENT_DATE: isoDate(ctx.now()),
  };

  let usedLlm = false;
  if (ctx.callLlm && (canvas || brandBrief)) {
    try {
      const synth = await callLlmStrict(ctx.callLlm, {
        system: `Write a 1-2 paragraph PRODUCT VISION for "${productName}". Plain prose, ~100-180 words. Focus on long-term direction; not feature list. UK context.`,
        user: `Spec canvas mission: ${canvas?.mission ?? "(none)"}\nBrand mission: ${brandBrief?.mission ?? "(none)"}\nProduct summary: ${brandBrief?.productSummary ?? "(none)"}\nAudience: ${brandBrief?.audience ?? "(none)"}`,
      });
      placeholders.VISION = synth;
      usedLlm = true;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notes.push(`product-vision: LLM failed -- using deterministic: ${m}`);
    }
  }

  return mkResult("product-vision", placeholders, sourcesRead, usedLlm, notes);
};

// ---------------------------------------------------------------------------
// user-flows
// ---------------------------------------------------------------------------

export const createUserFlowsStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const screensMd = await readTextIfExists(getScreensMarkdownPath(ctx.ventureRoot));
  if (screensMd) sourcesRead.push("06_product/wireframes/screens.md");

  // Extract per-screen Mermaid blocks; fall back to a generic 3-step
  // signup/use/upgrade flow.
  const blocks: string[] = [];
  if (screensMd) {
    const mermaidBlocks = extractAllMermaid(screensMd);
    blocks.push(...mermaidBlocks.slice(0, 8));
  }

  const wireframesDir = getWireframesDir(ctx.ventureRoot);
  const wireMd = await readMarkdownFiles(wireframesDir, { limit: 3 });
  for (const w of wireMd) sourcesRead.push(`06_product/wireframes/${w.filename}`);

  const detFlows = blocks.length > 0
    ? blocks.join("\n\n")
    : "```mermaid\nflowchart TD\n  A[Land on marketing site] --> B[Sign up]\n  B --> C[Onboarding]\n  C --> D[First success]\n  D --> E[Recurring use]\n  E --> F[Upgrade]\n```\n\n" +
        todoCallout("FLOWS", "run WIREFRAME stage to populate per-screen flows");

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    FLOWS: truncate(detFlows, 6000),
    CURRENT_DATE: isoDate(ctx.now()),
  };

  return mkResult("user-flows", placeholders, sourcesRead, false, notes);
};

// ---------------------------------------------------------------------------
// product-roadmap
// ---------------------------------------------------------------------------

export const createProductRoadmapStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const canvas = await readJsonIfExists<SpecCanvasLike>(getSpecCanvasPath(ctx.ventureRoot));
  if (canvas) sourcesRead.push("06_product/specs/spec-canvas.json");

  const audit = await readJsonIfExists<AuditLike>(
    join(getStagePath(ctx.ventureRoot, "build"), "audits", "audit.json")
  );
  if (audit) sourcesRead.push("07_build/audits/audit.json");

  // Bucket features by priority -> 3mo (P0), 6mo (P1), 12mo (P2/P3).
  const features = Array.isArray(canvas?.features) ? canvas!.features! : [];
  const m3: string[] = [];
  const m6: string[] = [];
  const m12: string[] = [];
  for (const f of features) {
    const name = (f.name ?? "").trim();
    if (!name) continue;
    const desc = (f.description ?? "").trim();
    const label = desc ? `${name} -- ${desc}` : name;
    const horizon = (f.horizon ?? "").toLowerCase();
    const priority = (f.priority ?? "").toUpperCase();
    if (horizon.includes("3") || priority === "P0") m3.push(label);
    else if (horizon.includes("6") || priority === "P1") m6.push(label);
    else m12.push(label);
  }
  if (audit?.findings) {
    for (const f of audit.findings.slice(0, 8)) {
      const rec = (f.recommendation ?? "").trim();
      if (!rec) continue;
      const horizon = (f.horizon ?? "").toLowerCase();
      if (horizon.includes("3")) m3.push(`Audit: ${rec}`);
      else if (horizon.includes("6")) m6.push(`Audit: ${rec}`);
      else m12.push(`Audit: ${rec}`);
    }
  }

  const sections: string[] = [];
  sections.push("### 3-month horizon");
  sections.push(bulletList(m3, todoCallout("3M", "no P0 features in spec-canvas")));
  sections.push("");
  sections.push("### 6-month horizon");
  sections.push(bulletList(m6, todoCallout("6M", "no P1 features in spec-canvas")));
  sections.push("");
  sections.push("### 12-month horizon");
  sections.push(bulletList(m12, todoCallout("12M", "no later-horizon features captured")));

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    ROADMAP: truncate(sections.join("\n"), 6000),
    CURRENT_DATE: isoDate(ctx.now()),
  };

  return mkResult("product-roadmap", placeholders, sourcesRead, false, notes);
};

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function extractAllMermaid(md: string): string[] {
  const out: string[] = [];
  const re = /```mermaid\b[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    out.push(m[0]);
  }
  return out;
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
