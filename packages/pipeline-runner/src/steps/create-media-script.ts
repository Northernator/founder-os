/**
 * Media script step -- synthesises launch-announcement.md + brand brief
 * (+ positioning if available) into a structured MediaScript that the
 * storyboard step then turns into shots.
 *
 * Inputs
 * ------
 *  - manifest:       venture.yaml (id/name/slug)
 *  - ventureRoot:    absolute venture folder
 *  - callLlm:        optional SaasLlmCaller. When provided, voiceover +
 *                    onScreen text are LLM-rewritten; without it,
 *                    deterministic copy is taken verbatim from the
 *                    upstream announcement. Subscription-mode CLIs
 *                    are preferred (per project policy) -- callers
 *                    constructed via buildPipelineLlmCaller already
 *                    route to Claude CLI / Gemini CLI when available.
 *  - fs:             injected Filesystem
 *
 * Reads (best-effort)
 * -------------------
 *  - 08_launch/launch-announcement.md  (primary copy source)
 *  - 03_brand/brand-kit/brand-brief.json  (name + tone for narration)
 *
 * Outputs (under 10_media/scripts/)
 * ---------------------------------
 *  - media-script.json  -- structured MediaScript (zod schema in media-core)
 *  - media-script.md    -- founder-readable rendering of the same script
 *
 * LLM failures are non-fatal: deterministic copy is the fallback and
 * generationSource flips to "deterministic-fallback".
 */
import type { VentureManifest } from "@founder-os/domain";
import type { MediaScript, Scene } from "@founder-os/media-core";
import type { Filesystem } from "../fs.js";
import {
  getMediaScriptJsonPath,
  getMediaScriptMdPath,
  getMediaScriptsDir,
  getStagePath,
} from "@founder-os/workspace-core";
import type { SaasLlmCaller } from "./create-saas-research-reports.js";

export type CreateMediaScriptContext = {
  fs: Filesystem;
  manifest: VentureManifest;
  ventureRoot: string;
  callLlm?: SaasLlmCaller;
  runId?: string;
};

export type CreateMediaScriptResult = {
  status: "done";
  jsonPath: string;
  mdPath: string;
  script: MediaScript;
  generationSource: "llm" | "deterministic" | "deterministic-fallback";
  sources: string[];
};

interface BrandSnippet {
  name?: string;
  tagline?: string;
  tone?: string;
}

async function readBrandBrief(
  fs: Filesystem,
  ventureRoot: string,
): Promise<BrandSnippet | null> {
  const path = `${getStagePath(ventureRoot, "brand")}/brand-kit/brand-brief.json`;
  if (!(await fs.exists(path))) return null;
  try {
    const raw = await fs.readFile(path);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: BrandSnippet = {};
    if (typeof parsed.name === "string") out.name = parsed.name;
    if (typeof parsed.tagline === "string") out.tagline = parsed.tagline;
    if (typeof parsed.tone === "string") out.tone = parsed.tone;
    return out;
  } catch {
    return null;
  }
}

async function readLaunchAnnouncement(
  fs: Filesystem,
  ventureRoot: string,
): Promise<string | null> {
  const path = `${getStagePath(ventureRoot, "launch")}/launch-announcement.md`;
  if (!(await fs.exists(path))) return null;
  try {
    return await fs.readFile(path);
  } catch {
    return null;
  }
}

/**
 * Split announcement markdown into ordered scenes. Heuristic:
 *  - h2 (## ...) starts a new scene; the heading becomes onScreen text
 *  - first non-heading paragraph becomes voiceover
 *  - visualBrief = best-effort summary derived from the section content
 *
 * If no h2 sections exist, fall back to one scene per paragraph.
 */
function deriveScenesFromAnnouncement(
  announcement: string,
  brand: BrandSnippet | null,
): Scene[] {
  const trimmed = announcement.trim();
  if (!trimmed) {
    return [
      {
        id: "scene-1",
        durationSec: 5,
        voiceover: brand?.tagline ?? brand?.name ?? "Welcome.",
        onScreen: brand?.name ?? "Launch",
        visualBrief: "Title card with brand name",
      },
    ];
  }

  // Split on lines that start with "## " (markdown h2).
  const sections = trimmed.split(/\n(?=## )/);
  if (sections.length === 1) {
    // No h2 headings -- one scene per paragraph, capped at 6 to keep
    // the reel short.
    const paras = trimmed.split(/\n{2,}/).slice(0, 6);
    return paras.map((para, i) => buildSceneFromParagraph(`scene-${i + 1}`, para, brand));
  }

  return sections.map((section, i) => buildSceneFromSection(`scene-${i + 1}`, section, brand));
}

function buildSceneFromSection(id: string, section: string, brand: BrandSnippet | null): Scene {
  const lines = section.split("\n");
  let onScreen = "";
  const bodyLines: string[] = [];
  for (const line of lines) {
    if (!onScreen && line.startsWith("## ")) {
      onScreen = line.slice(3).trim();
    } else {
      bodyLines.push(line);
    }
  }
  const body = bodyLines.join("\n").trim();
  const firstPara = body.split(/\n{2,}/)[0]?.trim() ?? "";
  const voiceover = firstPara || brand?.tagline || onScreen || "";
  return {
    id,
    durationSec: estimateDuration(voiceover),
    voiceover: voiceover.slice(0, 280),
    onScreen: onScreen.slice(0, 80),
    visualBrief: deriveVisualBrief(onScreen, firstPara),
  };
}

function buildSceneFromParagraph(id: string, para: string, brand: BrandSnippet | null): Scene {
  const trimmed = para.trim();
  return {
    id,
    durationSec: estimateDuration(trimmed),
    voiceover: trimmed.slice(0, 280),
    onScreen: brand?.name ?? "",
    visualBrief: deriveVisualBrief("", trimmed),
  };
}

function estimateDuration(text: string): number {
  // ~2.5 words per second of natural speech, +1s of room.
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(3, Math.min(15, Math.round(words / 2.5) + 1));
}

function deriveVisualBrief(onScreen: string, body: string): string {
  const lower = `${onScreen} ${body}`.toLowerCase();
  if (/\b(chart|metric|number|stat|growth|revenue|user)/.test(lower)) {
    return "Animated chart / metric reveal";
  }
  if (/\b(screen|ui|app|product|feature|demo)/.test(lower)) {
    return "Product UI demo";
  }
  if (/\b(team|founder|story|why)/.test(lower)) {
    return "Founder cameo + story beat";
  }
  if (/\b(launch|live|today|announce|release)/.test(lower)) {
    return "Title card / launch reveal";
  }
  return "Slide with kinetic typography";
}

async function maybeLlmEnrich(
  callLlm: SaasLlmCaller | undefined,
  brand: BrandSnippet | null,
  scenes: Scene[],
): Promise<{ scenes: Scene[]; source: "llm" | "deterministic" | "deterministic-fallback" }> {
  if (!callLlm) return { scenes, source: "deterministic" };
  try {
    const system =
      "You rewrite launch-video voiceover lines. Keep them concrete and " +
      "under 25 words. Do not invent metrics. Return JSON of the form " +
      `{"scenes":[{"id":"...","voiceover":"...","onScreen":"..."}]}.`;
    const user = JSON.stringify({
      brand,
      scenes: scenes.map((s) => ({
        id: s.id,
        voiceover: s.voiceover,
        onScreen: s.onScreen,
        visualBrief: s.visualBrief,
      })),
    });
    const out = await callLlm({ system, user });
    const parsed = JSON.parse(out) as { scenes?: Array<Partial<Scene> & { id: string }> };
    if (!parsed.scenes || !Array.isArray(parsed.scenes)) {
      return { scenes, source: "deterministic-fallback" };
    }
    const byId = new Map(parsed.scenes.map((s) => [s.id, s]));
    const enriched = scenes.map((s) => {
      const llm = byId.get(s.id);
      if (!llm) return s;
      const next: Scene = { ...s };
      if (typeof llm.voiceover === "string") next.voiceover = llm.voiceover.slice(0, 280);
      if (typeof llm.onScreen === "string") next.onScreen = llm.onScreen.slice(0, 80);
      return next;
    });
    return { scenes: enriched, source: "llm" };
  } catch {
    return { scenes, source: "deterministic-fallback" };
  }
}

function renderScriptMarkdown(script: MediaScript): string {
  const header = `# Media script -- ${script.ventureSlug}\n\n*Intent:* ${script.intent}\n\n`;
  const blocks = script.scenes
    .map((s) => {
      const lines = [`## Scene ${s.id} (${s.durationSec}s)`];
      if (s.onScreen) lines.push(`**On-screen:** ${s.onScreen}`);
      if (s.voiceover) lines.push(`**Voiceover:** ${s.voiceover}`);
      lines.push(`**Visual:** ${s.visualBrief}`);
      return lines.join("\n\n");
    })
    .join("\n\n");
  return `${header}${blocks}\n`;
}

export async function createMediaScriptStep(
  ctx: CreateMediaScriptContext,
): Promise<CreateMediaScriptResult> {
  const sources: string[] = [];
  await ctx.fs.mkdir(getMediaScriptsDir(ctx.ventureRoot));

  const brand = await readBrandBrief(ctx.fs, ctx.ventureRoot);
  if (brand) sources.push("brand-brief.json");
  const announcement = await readLaunchAnnouncement(ctx.fs, ctx.ventureRoot);
  if (announcement) sources.push("launch-announcement.md");

  const baseScenes = announcement
    ? deriveScenesFromAnnouncement(announcement, brand)
    : [
        {
          id: "scene-1",
          durationSec: 6,
          voiceover: brand?.tagline ?? `${ctx.manifest.name} is live.`,
          onScreen: brand?.name ?? ctx.manifest.name,
          visualBrief: "Title card with brand name",
        } satisfies Scene,
      ];

  const { scenes, source } = await maybeLlmEnrich(ctx.callLlm, brand, baseScenes);

  const script: MediaScript = {
    schemaVersion: 1,
    ventureSlug: ctx.manifest.slug,
    intent: "IDEA_TO_VIDEO",
    scenes,
    generatedAt: new Date().toISOString(),
  };

  const jsonPath = getMediaScriptJsonPath(ctx.ventureRoot);
  const mdPath = getMediaScriptMdPath(ctx.ventureRoot);
  await ctx.fs.writeFile(jsonPath, `${JSON.stringify(script, null, 2)}\n`);
  await ctx.fs.writeFile(mdPath, renderScriptMarkdown(script));

  return {
    status: "done",
    jsonPath,
    mdPath,
    script,
    generationSource: source,
    sources,
  };
}
