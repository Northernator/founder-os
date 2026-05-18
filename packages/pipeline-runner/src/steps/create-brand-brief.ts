/**
 * create-brand-brief.ts -- produces 03_brand/brand-kit/brand-brief.json.
 *
 * Architecture
 * ------------
 * The brand brief is structured config + creative copy. We split those
 * two concerns deliberately:
 *
 *   1. CONFIG (deterministic): colorPalette + typography + logoSpec.
 *      These are design-system anchors, not creative outputs. Hardcoded
 *      palette presets keyed off the leading personality. Driving these
 *      from an LLM would produce inconsistent hex codes and break
 *      downstream branded-PDF rendering that key-matches off the
 *      palette schema.
 *
 *   2. CREATIVE (LLM): tagline + mission + targetAudience + toneOfVoice
 *      + differentiators. These were previously templated strings like
 *      "The smart way to ${industry}" -- now they are Gemini-narrated
 *      via the injected callLlm. The JSON output shape is byte-
 *      identical to the old version so handoff-pack consumers,
 *      branded-PDF generators, and the BrandTab UI all stay working.
 *
 * Failure mode
 * ------------
 * If the LLM call throws or returns malformed JSON, we throw a clear
 * error rather than silently falling back to templates. The user
 * explicitly asked to remove the old templated path, so partial
 * fallbacks would be lying about what the runner produced.
 */
import {
  type BrandBrief,
  type BrandPersonality,
  createBrandBrief,
} from "@founder-os/branding-core";
import type { VentureManifest } from "@founder-os/domain";
import { createLogger } from "@founder-os/logger";
import { getBrandKitDir } from "@founder-os/workspace-core";
import type { Filesystem } from "../fs.js";
import type { OrchestratorLlmCaller } from "../orchestrator.js";

const log = createLogger("pipeline-runner:create-brand-brief");

const DEFAULT_PALETTES: Record<string, BrandBrief["colorPalette"]> = {
  bold: {
    primary: "#FF3B30",
    secondary: "#FF6B35",
    accent: "#FFD60A",
    background: "#FFFFFF",
    surface: "#F5F5F5",
    text: "#1C1C1E",
    textMuted: "#6C6C70",
  },
  minimal: {
    primary: "#000000",
    secondary: "#333333",
    accent: "#0066CC",
    background: "#FFFFFF",
    surface: "#F2F2F7",
    text: "#1C1C1E",
    textMuted: "#8E8E93",
  },
  playful: {
    primary: "#5E5CE6",
    secondary: "#FF6EAB",
    accent: "#30D158",
    background: "#FFFFFF",
    surface: "#F2F2F7",
    text: "#1C1C1E",
    textMuted: "#8E8E93",
  },
  technical: {
    primary: "#0A84FF",
    secondary: "#30D158",
    accent: "#FF9F0A",
    background: "#000000",
    surface: "#1C1C1E",
    text: "#FFFFFF",
    textMuted: "#8E8E93",
  },
};

export type CreateBrandBriefContext = {
  fs: Filesystem;
  manifest: VentureManifest;
  ventureRoot: string;
  personalities?: BrandPersonality[];
  /**
   * Required LLM caller for the creative fields. Routed via the host
   * app provider selector (Gemini-pinned in the desktop helper). If
   * the runner validate() let us through, this is non-null.
   */
  callLlm: OrchestratorLlmCaller;
};

type LlmBrandFields = {
  tagline: string;
  mission: string;
  targetAudience: string;
  toneOfVoice: string;
  differentiators: string[];
};

const BRAND_BRIEF_SYSTEM_PROMPT = `You are a brand strategist for early-stage tech startups. Given a venture name, industry, and personality, produce concise brand brief content.

Return ONLY a fenced \`\`\`json block with this exact shape:

{
  "tagline": "string -- 4-9 words, memorable, punchy, no period at the end",
  "mission": "string -- one sentence, ~15-25 words, what the company exists to do",
  "targetAudience": "string -- one phrase, ~6-15 words, who this is for",
  "toneOfVoice": "string -- one phrase, ~3-8 words, how the brand speaks",
  "differentiators": ["string", "string", "string"]
}

The differentiators array MUST have exactly 3 entries, each 2-6 words. No marketing fluff -- pick concrete, defensible things this venture does differently. Do not include any commentary outside the JSON block.`;

export async function createBrandBriefStep(
  ctx: CreateBrandBriefContext
): Promise<{ status: string; producedArtifactIds: string[]; brief: BrandBrief }> {
  const brandKitDir = getBrandKitDir(ctx.ventureRoot);
  await ctx.fs.mkdir(brandKitDir);

  const briefPath = `${brandKitDir}/brand-brief.json`;

  if (await ctx.fs.exists(briefPath)) {
    log.info(`Brand brief already exists at ${briefPath}`);
    const existing = JSON.parse(await ctx.fs.readFile(briefPath)) as BrandBrief;
    return { status: "skipped", producedArtifactIds: [], brief: existing };
  }

  const personalities = ctx.personalities ?? ["minimal", "technical"];
  // biome-ignore lint/style/noNonNullAssertion: value asserted non-null by surrounding logic
  const palette = DEFAULT_PALETTES[personalities[0] ?? "minimal"] ?? DEFAULT_PALETTES.minimal!;

  // LLM-narrated creative fields. We require a successful response;
  // there is no template fallback by design.
  const llmFields = await callForCreativeFields(ctx.callLlm, ctx.manifest, personalities);

  const brief = createBrandBrief({
    ventureId: ctx.manifest.id,
    ventureSlug: ctx.manifest.slug,
    companyName: ctx.manifest.name,
    tagline: llmFields.tagline,
    mission: llmFields.mission,
    targetAudience: llmFields.targetAudience,
    personality: personalities,
    toneOfVoice: llmFields.toneOfVoice,
    competitors: [],
    differentiators: llmFields.differentiators,
    colorPalette: palette,
    typography: {
      headingFont: "Inter",
      bodyFont: "Inter",
      monoFont: "JetBrains Mono",
      headingWeight: 700,
      bodyWeight: 400,
      scaleBase: 16,
    },
    logoSpec: {
      style: "icon+wordmark",
      tagline: llmFields.tagline,
    },
  });

  await ctx.fs.writeFile(briefPath, JSON.stringify(brief, null, 2));
  log.info(`Created brand brief at ${briefPath}`);

  return { status: "done", producedArtifactIds: [], brief };
}

async function callForCreativeFields(
  callLlm: OrchestratorLlmCaller,
  manifest: VentureManifest,
  personalities: BrandPersonality[]
): Promise<LlmBrandFields> {
  const userPrompt = [
    `Company name: ${manifest.name}`,
    `Slug: ${manifest.slug}`,
    `Industry / domain: ${manifest.industry ?? "general software"}`,
    `Product type: ${manifest.appType}`,
    `Personality (lead first): ${personalities.join(", ")}`,
    ``,
    `Generate the brand brief creative fields per the schema in your system instructions.`,
  ].join("\n");

  const raw = await callLlm({
    system: BRAND_BRIEF_SYSTEM_PROMPT,
    user: userPrompt,
  });

  const parsed = parseLlmJson(raw);
  validateLlmFields(parsed);
  return parsed;
}

/**
 * Best-effort JSON extraction matching the same patterns the naming
 * step uses: prefer a fenced ```json block, fall back to any fenced
 * block, fall back to the first {...} substring.
 */
function parseLlmJson(raw: string): LlmBrandFields {
  const trimmed = raw.trim();
  const fencedJson = /```json\s*\n?([\s\S]*?)\n?```/i.exec(trimmed);
  const fencedAny = /```\s*\n?([\s\S]*?)\n?```/.exec(trimmed);
  const bareObject = /\{[\s\S]*\}/.exec(trimmed);

  const candidate = (fencedJson?.[1] ?? fencedAny?.[1] ?? bareObject?.[0] ?? trimmed).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Brand brief LLM returned unparseable JSON: ${message}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Brand brief LLM returned non-object JSON");
  }
  return parsed as LlmBrandFields;
}

function validateLlmFields(fields: LlmBrandFields): void {
  const errors: string[] = [];
  if (typeof fields.tagline !== "string" || fields.tagline.trim().length === 0) {
    errors.push("tagline missing or empty");
  }
  if (typeof fields.mission !== "string" || fields.mission.trim().length === 0) {
    errors.push("mission missing or empty");
  }
  if (typeof fields.targetAudience !== "string" || fields.targetAudience.trim().length === 0) {
    errors.push("targetAudience missing or empty");
  }
  if (typeof fields.toneOfVoice !== "string" || fields.toneOfVoice.trim().length === 0) {
    errors.push("toneOfVoice missing or empty");
  }
  if (
    !Array.isArray(fields.differentiators) ||
    fields.differentiators.length === 0 ||
    fields.differentiators.some((d) => typeof d !== "string" || d.trim().length === 0)
  ) {
    errors.push("differentiators missing, empty, or contains non-strings");
  }
  if (errors.length > 0) {
    throw new Error(`Brand brief LLM response invalid: ${errors.join("; ")}`);
  }
}
