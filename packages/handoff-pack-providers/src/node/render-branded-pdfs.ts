/**
 * Slice 8 -- per-stage branded PDF refresh.
 *
 * Renders only the manifest docs sourced by one pipeline stage, reusing
 * the same brand prep, Golden/Tier-B dispatch, template context, and
 * render primitive as the full HANDOFF_PACK orchestrator.
 */
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { DOC_MANIFEST } from "@founder-os/handoff-pack-core/manifest";
import {
  pdfRelativePathFor,
  type BrandTokens,
  type DocDescriptor,
  type InventoryEntry,
  type PdfTemplateConfig,
  type SourceStage,
} from "@founder-os/handoff-pack-core";
import {
  HandoffPackRenderError,
  HandoffPackTemplateError,
  type PdfEngine,
  type PrepareBrandAssetsResult,
} from "../types.js";
import {
  dispatchGoldenSteps,
  type DispatchGoldenStepsResult,
  type GoldenLlmCaller,
} from "./golden/index.js";
import {
  dispatchTierBSteps,
  type DispatchTierBStepsResult,
} from "./tier-b/index.js";
import { createMinimalPdfEngine } from "./minimal-pdf-engine.js";
import {
  prepareBrandAssetsStep,
  type PrepareBrandAssetsOpts,
} from "./prepare-brand-assets.js";
import { renderPdfStep } from "./render-pdf.js";

function defaultTemplatesRoot(): string {
  const here = fileURLToPath(import.meta.url);
  const packagesDir = resolve(dirname(here), "..", "..", "..");
  return join(packagesDir, "handoff-pack-templates", "templates");
}

export type RenderBrandedPdfsStepOpts = {
  ventureRoot: string;
  ventureName: string;
  ventureSlug: string;
  sourceStage: SourceStage;
  prepareOverrides?: Pick<
    PrepareBrandAssetsOpts,
    "brandBriefPath" | "logoSvgSourcePath"
  >;
  templatesRoot?: string;
  engine?: PdfEngine;
  now?: () => Date;
  callLlm?: GoldenLlmCaller;
  skipGolden?: boolean;
  skipTierB?: boolean;
  contextOverrides?: Readonly<Record<string, Record<string, string>>>;
};

export type RenderBrandedPdfsStepResult = {
  sourceStage: SourceStage;
  matched: number;
  brand: PrepareBrandAssetsResult;
  entries: InventoryEntry[];
  counts: {
    generated: number;
    partial: number;
    stub: number;
    manual: number;
    failed: number;
    pending: number;
  };
  golden?: DispatchGoldenStepsResult;
  tierB?: DispatchTierBStepsResult;
  notes: string[];
};

export async function renderBrandedPdfsStep(
  opts: RenderBrandedPdfsStepOpts
): Promise<RenderBrandedPdfsStepResult> {
  const now = opts.now ?? (() => new Date());
  const engine = opts.engine ?? createMinimalPdfEngine({ now });
  const templatesRoot = opts.templatesRoot ?? defaultTemplatesRoot();

  const brand = await prepareBrandAssetsStep({
    ventureRoot: opts.ventureRoot,
    ventureName: opts.ventureName,
    now,
    ...(opts.prepareOverrides ?? {}),
  });

  let golden: DispatchGoldenStepsResult | undefined;
  let goldenOverrides: Record<string, Record<string, string>> = {};
  if (!opts.skipGolden) {
    golden = await dispatchGoldenSteps({
      ventureRoot: opts.ventureRoot,
      ventureName: opts.ventureName,
      ventureSlug: opts.ventureSlug,
      brandTokens: brand.tokens,
      now,
      callLlm: opts.callLlm,
    });
    goldenOverrides = golden.contextOverrides;
  }

  let tierB: DispatchTierBStepsResult | undefined;
  let tierBOverrides: Record<string, Record<string, string>> = {};
  if (!opts.skipTierB) {
    tierB = await dispatchTierBSteps({
      ventureRoot: opts.ventureRoot,
      ventureName: opts.ventureName,
      ventureSlug: opts.ventureSlug,
      brandTokens: brand.tokens,
      now,
      callLlm: opts.callLlm,
    });
    tierBOverrides = tierB.contextOverrides;
  }

  const mergedOverrides: Record<string, Record<string, string>> = {
    ...goldenOverrides,
    ...tierBOverrides,
  };
  for (const [docId, fields] of Object.entries(opts.contextOverrides ?? {})) {
    mergedOverrides[docId] = { ...mergedOverrides[docId], ...fields };
  }

  const candidates = DOC_MANIFEST.filter((descriptor) =>
    descriptor.sourceStages.includes(opts.sourceStage)
  );

  const entries: InventoryEntry[] = [];
  const notes: string[] = [
    ...brand.notes,
    ...(golden ? golden.notes : []),
    ...(tierB ? tierB.notes : []),
  ];
  const counts: RenderBrandedPdfsStepResult["counts"] = {
    generated: 0,
    partial: 0,
    stub: 0,
    manual: 0,
    failed: 0,
    pending: 0,
  };

  for (const descriptor of candidates) {
    const templatePath = join(templatesRoot, descriptor.templatePath);
    const context = buildContext({
      descriptor,
      ventureName: opts.ventureName,
      ventureSlug: opts.ventureSlug,
      tokens: brand.tokens,
      now: now(),
      override: mergedOverrides[descriptor.id],
    });

    try {
      const result = await renderPdfStep({
        ventureRoot: opts.ventureRoot,
        descriptor,
        tokens: brand.tokens,
        config: brand.config,
        engine,
        templatePath,
        context,
      });
      entries.push({
        docId: descriptor.id,
        category: descriptor.category,
        slot: descriptor.slot,
        title: descriptor.title,
        tier: descriptor.tier,
        status: result.status,
        pdfRelativePath: pdfRelativePathFor(descriptor),
        lastRenderedAt: result.renderedAt,
      });
      counts[result.status]++;
    } catch (err) {
      const reason = formatRenderError(err);
      entries.push({
        docId: descriptor.id,
        category: descriptor.category,
        slot: descriptor.slot,
        title: descriptor.title,
        tier: descriptor.tier,
        status: "failed",
        pdfRelativePath: pdfRelativePathFor(descriptor),
        failureReason: reason,
      });
      counts.failed++;
      notes.push(`stage-pdf:${opts.sourceStage}:${descriptor.id} failed -- ${reason}`);
    }
  }

  notes.push(`stage-pdf:${opts.sourceStage} matched=${candidates.length} failed=${counts.failed}`);

  return {
    sourceStage: opts.sourceStage,
    matched: candidates.length,
    brand,
    entries,
    counts,
    ...(golden ? { golden } : {}),
    ...(tierB ? { tierB } : {}),
    notes,
  };
}

function buildContext(args: {
  descriptor: DocDescriptor;
  ventureName: string;
  ventureSlug: string;
  tokens: BrandTokens;
  now: Date;
  override?: Record<string, string>;
}): Record<string, string> {
  const isoDate = args.now.toISOString().slice(0, 10);
  const ctx: Record<string, string> = {
    COMPANY_NAME: args.ventureName,
    COMPANY_SLUG: args.ventureSlug,
    CURRENT_DATE: isoDate,
    BRAND_PRIMARY_COLOR: args.tokens.colors.primary,
    BRAND_SECONDARY_COLOR: args.tokens.colors.secondary,
    BRAND_HEADING_FONT: args.tokens.fonts.heading,
    BRAND_BODY_FONT: args.tokens.fonts.body,
    DOC_TITLE: args.descriptor.title,
    DOC_ID: args.descriptor.id,
    DOC_CATEGORY: args.descriptor.category,
    DOC_TIER: args.descriptor.tier,
  };
  if (args.override) {
    for (const [k, v] of Object.entries(args.override)) {
      ctx[k] = v;
    }
  }
  return ctx;
}

function formatRenderError(err: unknown): string {
  if (err instanceof HandoffPackRenderError) {
    return `render error (engine=${err.engineId}, out=${err.outputPath}): ${err.message}`;
  }
  if (err instanceof HandoffPackTemplateError) {
    return `template error: unresolved=${err.unresolvedPlaceholders.join(",")}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export type { BrandTokens, PdfTemplateConfig, SourceStage };
