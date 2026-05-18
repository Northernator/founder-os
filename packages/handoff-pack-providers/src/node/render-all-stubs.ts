/**
 * renderAllStubsStep -- iterate the manifest, render every doc to PDF.
 *
 * NODE-ONLY. Lives behind the /node entry point because it reads
 * template files off disk and calls renderPdfStep (which writes
 * binary PDFs via node:fs/promises through the PdfEngine).
 *
 * Slice 5 of the handoff-pack arc. This is the bulk worker the
 * HandoffPackStageRunner drives once prepareBrandAssetsStep has
 * shipped tokens + config + logo into 13_handoff_pack/.brand/. The
 * walker:
 *
 *   1. Filters DOC_MANIFEST by HandoffPackConfig.excludeTiers.
 *   2. For each remaining descriptor:
 *      a. Resolves the on-disk template path under
 *         packages/handoff-pack-templates/templates/.
 *      b. Builds a TemplateContext from the venture + brand tokens
 *         (slice 6+7 layer LLM-generated values on top for tiers A+B;
 *         slice 5 ships only the manifest-derived defaults).
 *      c. Calls renderPdfStep with the configured PdfEngine.
 *      d. On success appends a `generated`/`stub`/`partial` row to
 *         the inventory.
 *      e. On error (template missing, PDF emitter failure, strict-mode
 *         unresolved placeholder for tier A/B/C) appends a `failed`
 *         row with the human-readable cause. The walk continues so
 *         the founder gets a partial pack rather than a hard fail.
 *
 * Outputs are an InventoryEntry[] keyed by descriptor.id plus
 * status counts. The orchestrator (renderHandoffPackArtefactsStep)
 * wraps this with prepareBrandAssetsStep and assembles the final
 * HandoffPackInventory envelope.
 */
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  DOC_MANIFEST,
} from "@founder-os/handoff-pack-core/manifest";
import {
  pdfBasenameFor,
  pdfRelativePathFor,
  type BrandTokens,
  type DocDescriptor,
  type InventoryEntry,
  type PdfTemplateConfig,
  type Tier,
} from "@founder-os/handoff-pack-core";
import {
  HandoffPackRenderError,
  HandoffPackTemplateError,
  type PdfEngine,
} from "../types.js";
import { renderPdfStep } from "./render-pdf.js";

/** Where the on-disk template tree lives relative to this file. */
function defaultTemplatesRoot(): string {
  // This file is .../packages/handoff-pack-providers/src/node/render-all-stubs.ts
  // The templates live at .../packages/handoff-pack-templates/templates/.
  // Walk up three dirs (node -> src -> handoff-pack-providers -> packages),
  // then descend into handoff-pack-templates/templates.
  const here = fileURLToPath(import.meta.url);
  const packagesDir = resolve(dirname(here), "..", "..", "..");
  return join(packagesDir, "handoff-pack-templates", "templates");
}

export type RenderAllStubsStepOpts = {
  /** Absolute venture root, e.g. /ventures/acme/. */
  ventureRoot: string;
  /** Mirrors VentureManifest.name -- surfaced in every doc body. */
  ventureName: string;
  /** Mirrors VentureManifest.slug -- surfaced in every doc body. */
  ventureSlug: string;
  /** From prepareBrandAssetsStep -- threaded into every renderPdfStep call. */
  tokens: BrandTokens;
  /** From prepareBrandAssetsStep -- header/footer + page rules. */
  config: PdfTemplateConfig;
  /** PdfEngine implementation. Default: createMinimalPdfEngine() per slice 2. */
  engine: PdfEngine;
  /** Skip tiers entirely. Default = render all 4. */
  excludeTiers?: ReadonlyArray<Tier>;
  /**
   * Optional override of the templates root for fixtures. When absent,
   * resolved via import.meta.url relative to this file's package.
   */
  templatesRoot?: string;
  /** Optional clock for deterministic tests. */
  now?: () => Date;
  /**
   * Optional iteration cap. Default = render the full manifest. Tests
   * use this to keep fixtures fast (a single descriptor proves the
   * walk + per-doc try/catch + inventory shape).
   */
  limit?: number;
  /**
   * Optional per-doc context overrides. Keyed by descriptor.id. Slice
   * 6+7 will use this to inject LLM-generated narrative slots for
   * Golden 15 + extended-tier docs.
   */
  contextOverrides?: Readonly<Record<string, Record<string, string>>>;
};

export type RenderAllStubsStepResult = {
  entries: InventoryEntry[];
  counts: {
    generated: number;
    partial: number;
    stub: number;
    manual: number;
    failed: number;
    pending: number;
  };
  /** Free-form notes the orchestrator can surface in the checkpoint. */
  notes: string[];
};

export async function renderAllStubsStep(
  opts: RenderAllStubsStepOpts
): Promise<RenderAllStubsStepResult> {
  const now = opts.now ?? (() => new Date());
  const templatesRoot = opts.templatesRoot ?? defaultTemplatesRoot();
  const excludeTiers = new Set<Tier>(opts.excludeTiers ?? []);

  const entries: InventoryEntry[] = [];
  const notes: string[] = [];
  const counts: RenderAllStubsStepResult["counts"] = {
    generated: 0,
    partial: 0,
    stub: 0,
    manual: 0,
    failed: 0,
    pending: 0,
  };

  // Stable iteration order: DOC_MANIFEST is authored category->slot,
  // and InventoryEntry rows in INDEX.md echo that.
  const candidates: ReadonlyArray<DocDescriptor> = opts.limit
    ? DOC_MANIFEST.slice(0, opts.limit)
    : DOC_MANIFEST;

  for (const descriptor of candidates) {
    if (excludeTiers.has(descriptor.tier)) {
      // Excluded tiers land in the inventory as `pending` so the
      // founder can see what was suppressed via config.
      entries.push(buildPendingEntry(descriptor));
      counts.pending++;
      continue;
    }

    const templatePath = join(templatesRoot, descriptor.templatePath);
    const context = buildContext({
      descriptor,
      ventureName: opts.ventureName,
      ventureSlug: opts.ventureSlug,
      tokens: opts.tokens,
      now: now(),
      override: opts.contextOverrides?.[descriptor.id],
    });

    try {
      const result = await renderPdfStep({
        ventureRoot: opts.ventureRoot,
        descriptor,
        tokens: opts.tokens,
        config: opts.config,
        engine: opts.engine,
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
      notes.push(`failed: ${descriptor.id} -- ${reason}`);
    }
  }

  return { entries, counts, notes };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function buildPendingEntry(descriptor: DocDescriptor): InventoryEntry {
  return {
    docId: descriptor.id,
    category: descriptor.category,
    slot: descriptor.slot,
    title: descriptor.title,
    tier: descriptor.tier,
    status: "pending",
    pdfRelativePath: pdfRelativePathFor(descriptor),
  };
}

/**
 * Compose the Handlebars context every template can rely on. Slice 5
 * ships the manifest-derived defaults only. Slice 6+7 layer LLM-
 * generated narrative slots on top via opts.contextOverrides.
 *
 * Placeholders the manifest declares but this function doesn't fill
 * fall through to the template engine's mode handling: lenient (tier D)
 * substitutes a TODO callout; strict (tier A/B/C) throws and the
 * caller surfaces the failure as a `failed` inventory row.
 */
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

// Re-export pdfBasenameFor for callers that compose inventory rows
// before invoking the walker (handful of tests do this).
export { pdfBasenameFor };
