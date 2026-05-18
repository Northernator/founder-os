/**
 * Slice 6 -- product-tier Golden steps.
 *
 * Three docs:
 *   - prd          -- product requirements: features, AC, constraints.
 *   - mvp-scope    -- in-scope / out-of-scope / later split.
 *   - user-stories -- "As a <role>..." statements extracted from spec.
 *
 * NODE-ONLY. Reads 06_product/specs/spec-canvas.json + product-spec.md
 * + 06_product/brief/. Each step degrades to TODO callouts when the
 * canvas is missing.
 */
import { join } from "node:path";
import {
  getProductSpecMarkdownPath,
  getSpecCanvasPath,
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
} from "./helpers.js";
import type { GoldenStep, GoldenStepResult } from "./types.js";

// ---------------------------------------------------------------------------
// Shared spec-canvas shape (best-effort -- product-canvas is a UI canvas
// so we don't hard-bind to its schema; we read defensively).
// ---------------------------------------------------------------------------

type FeatureLike = {
  name?: string;
  description?: string;
  priority?: string;
  acceptanceCriteria?: string[];
  status?: string;
};

type SpecCanvasLike = {
  productName?: string;
  mission?: string;
  features?: FeatureLike[];
  constraints?: string[];
  inScope?: string[];
  outOfScope?: string[];
  laterScope?: string[];
  later?: string[];
};

async function loadSpecCanvas(ventureRoot: string): Promise<SpecCanvasLike | null> {
  return readJsonIfExists<SpecCanvasLike>(getSpecCanvasPath(ventureRoot));
}

async function loadProductSpecMd(ventureRoot: string): Promise<string | null> {
  return readTextIfExists(getProductSpecMarkdownPath(ventureRoot));
}

function featureLineFor(f: FeatureLike, idx: number): string {
  const name = f.name?.trim() || `Feature ${idx + 1}`;
  const desc = f.description?.trim() || "(no description captured)";
  const prio = f.priority?.trim();
  const prioSuffix = prio ? ` _(priority: ${prio})_` : "";
  return `**${name}**${prioSuffix} -- ${desc}`;
}

// ---------------------------------------------------------------------------
// prd
// ---------------------------------------------------------------------------

export const createPrdStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const canvas = await loadSpecCanvas(ctx.ventureRoot);
  if (canvas) sourcesRead.push("06_product/specs/spec-canvas.json");

  const productSpecMd = await loadProductSpecMd(ctx.ventureRoot);
  if (productSpecMd) sourcesRead.push("06_product/specs/product-spec.md");

  const productName = canvas?.productName?.trim() || ctx.ventureName;
  const features = Array.isArray(canvas?.features) ? canvas!.features! : [];

  const detFeatures = features.length > 0
    ? features.slice(0, 20).map((f, i) => `- ${featureLineFor(f, i)}`).join("\n")
    : todoCallout("FEATURES", "no features in spec-canvas.json -- run PRODUCT_SPEC stage");

  const acLines = features
    .flatMap((f, idx) => {
      const name = f.name?.trim() || `Feature ${idx + 1}`;
      const ac = Array.isArray(f.acceptanceCriteria) ? f.acceptanceCriteria : [];
      return ac.length > 0
        ? [`**${name}:**`, ...ac.map((a) => `- ${a.trim()}`)]
        : [];
    });
  const detAc = acLines.length > 0
    ? acLines.join("\n")
    : todoCallout("ACCEPTANCE_CRITERIA", "no acceptance criteria captured -- fill in spec canvas");

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    PRODUCT_NAME: productName,
    CURRENT_DATE: isoDate(ctx.now()),
    FEATURES: truncate(detFeatures, 3000),
    ACCEPTANCE_CRITERIA: truncate(detAc, 3000),
  };

  let usedLlm = false;
  if (ctx.callLlm && features.length > 0) {
    try {
      const synth = await callLlmStrict(ctx.callLlm, {
        system: `You are writing the FEATURES section of a PRD for "${productName}". Output a markdown bullet list (one bullet per feature, with bolded name + short description). Cite the canvas verbatim where possible. Keep it under 400 words.`,
        user: `Spec canvas features:\n${JSON.stringify(features.slice(0, 20), null, 2)}\n\nProduct spec md excerpt:\n${truncate(productSpecMd ?? "(none)", 1500)}`,
      });
      placeholders.FEATURES = synth;
      usedLlm = true;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notes.push(`prd: LLM failed -- using deterministic: ${m}`);
    }
  }

  return { docId: "prd", placeholders, sourcesRead, usedLlm, notes };
};

// ---------------------------------------------------------------------------
// mvp-scope
// ---------------------------------------------------------------------------

export const createMvpScopeStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const canvas = await loadSpecCanvas(ctx.ventureRoot);
  if (canvas) sourcesRead.push("06_product/specs/spec-canvas.json");

  const briefDir = join(getStagePath(ctx.ventureRoot, "product"), "brief");
  const briefFiles = await readMarkdownFiles(briefDir, { limit: 3 });
  for (const b of briefFiles) sourcesRead.push(`06_product/brief/${b.filename}`);

  const inScope = Array.isArray(canvas?.inScope) ? canvas!.inScope! : [];
  const outOfScope = Array.isArray(canvas?.outOfScope) ? canvas!.outOfScope! : [];
  const later = Array.isArray(canvas?.laterScope)
    ? canvas!.laterScope!
    : Array.isArray(canvas?.later)
      ? canvas!.later!
      : [];

  // Fallback: derive from features by priority.
  const features = Array.isArray(canvas?.features) ? canvas!.features! : [];
  const inferIn = features
    .filter((f) => (f.priority ?? "").toLowerCase().startsWith("p0") || (f.priority ?? "").toLowerCase() === "must")
    .map((f) => f.name?.trim() ?? "")
    .filter((s) => s.length > 0);
  const inferLater = features
    .filter((f) => (f.priority ?? "").toLowerCase().startsWith("p2") || (f.priority ?? "").toLowerCase() === "later")
    .map((f) => f.name?.trim() ?? "")
    .filter((s) => s.length > 0);

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    CURRENT_DATE: isoDate(ctx.now()),
    IN_SCOPE: bulletList(
      inScope.length > 0 ? inScope : inferIn,
      todoCallout("IN_SCOPE", "no in-scope list -- fill MVP scope in spec canvas")
    ),
    OUT_OF_SCOPE: bulletList(
      outOfScope,
      todoCallout("OUT_OF_SCOPE", "fill out-of-scope explicitly to avoid scope creep")
    ),
    LATER: bulletList(
      later.length > 0 ? later : inferLater,
      todoCallout("LATER", "no 'later' bucket -- defer v2 items here")
    ),
  };

  let usedLlm = false;
  if (ctx.callLlm && (inScope.length > 0 || features.length > 0)) {
    try {
      const synth = await callLlmStrict(ctx.callLlm, {
        system: `You are writing the IN-SCOPE section of an MVP scope document for "${ctx.ventureName}". Output a markdown bullet list of the v1 must-haves with one-line rationale each. ~150-300 words.`,
        user: `Canvas in-scope: ${JSON.stringify(inScope)}\nFeatures: ${JSON.stringify(features.slice(0, 15), null, 2)}\nBrief excerpts: ${briefFiles.map((b) => b.filename).join(", ") || "(none)"}`,
      });
      placeholders.IN_SCOPE = synth;
      usedLlm = true;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notes.push(`mvp-scope: LLM failed -- using deterministic: ${m}`);
    }
  }

  return { docId: "mvp-scope", placeholders, sourcesRead, usedLlm, notes };
};

// ---------------------------------------------------------------------------
// user-stories
// ---------------------------------------------------------------------------

export const createUserStoriesStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const canvas = await loadSpecCanvas(ctx.ventureRoot);
  if (canvas) sourcesRead.push("06_product/specs/spec-canvas.json");

  const features = Array.isArray(canvas?.features) ? canvas!.features! : [];

  // Deterministic: synthesize a story line per feature.
  const stories = features.slice(0, 30).map((f, idx) => {
    const name = f.name?.trim() || `Feature ${idx + 1}`;
    const desc = f.description?.trim() || "perform an action";
    return `- As a user, I want to **${name.toLowerCase()}** so that ${desc.replace(/\.$/, "").toLowerCase()}.`;
  });

  const detStories = stories.length > 0
    ? stories.join("\n")
    : todoCallout("STORIES", "no features in spec-canvas.json -- run PRODUCT_SPEC stage first");

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    CURRENT_DATE: isoDate(ctx.now()),
    STORIES: truncate(detStories, 4000),
  };

  let usedLlm = false;
  if (ctx.callLlm && features.length > 0) {
    try {
      const synth = await callLlmStrict(ctx.callLlm, {
        system: `You are writing USER STORIES for "${ctx.ventureName}". Output a markdown bullet list, one story per bullet, in the form "As a <role>, I want to <action>, so that <benefit>." Aim for 1-3 stories per feature. Group by feature with a bold header line. ~200-500 words total.`,
        user: `Features (JSON):\n${JSON.stringify(features.slice(0, 25), null, 2)}`,
      });
      placeholders.STORIES = synth;
      usedLlm = true;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notes.push(`user-stories: LLM failed -- using deterministic: ${m}`);
    }
  }

  return { docId: "user-stories", placeholders, sourcesRead, usedLlm, notes };
};
