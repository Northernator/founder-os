import {
  type BrandBrief,
  type BrandPersonality,
  createBrandBrief,
} from "@founder-os/branding-core";
import type { VentureManifest } from "@founder-os/domain";
import { createLogger } from "@founder-os/logger";
import { getBrandKitDir } from "@founder-os/workspace-core";
import type { Filesystem } from "../fs.js";

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
};

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

  const brief = createBrandBrief({
    ventureId: ctx.manifest.id,
    ventureSlug: ctx.manifest.slug,
    companyName: ctx.manifest.name,
    tagline: `The smart way to ${ctx.manifest.industry ?? "build"}.`,
    mission: `Help ${ctx.manifest.industry ?? "founders"} build better, faster.`,
    targetAudience: `Founders building ${ctx.manifest.appType} products`,
    personality: personalities,
    toneOfVoice: personalities.includes("playful") ? "Warm and approachable" : "Clear and direct",
    competitors: [],
    differentiators: ["AI-first", "Founder-centric", "UK-native"],
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
      tagline: `The smart way to ${ctx.manifest.industry ?? "build"}.`,
    },
  });

  await ctx.fs.writeFile(briefPath, JSON.stringify(brief, null, 2));
  log.info(`Created brand brief at ${briefPath}`);

  return { status: "done", producedArtifactIds: [], brief };
}
