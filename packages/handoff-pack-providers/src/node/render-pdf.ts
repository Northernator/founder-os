/**
 * renderPdfStep -- the per-doc rendering primitive.
 *
 * NODE-ONLY. Lives behind the /node entry point because it touches
 * the filesystem (reads the template source, writes the PDF via the
 * engine).
 *
 * The pipeline:
 *   1. Resolve the template source. Caller can pass either an
 *      inline string (slice 2 proof + tests) or a path under
 *      packages/handoff-pack-templates/ (slice 3+).
 *   2. Run the template through the Handlebars-subset engine with
 *      tier-driven mode (strict for A/B/C, lenient for D).
 *   3. Convert the substituted markdown to HTML.
 *   4. Wrap the HTML in the branded shell.
 *   5. Hand the HTML + descriptor + tokens + config to the PdfEngine
 *      to land on disk.
 *
 * The orchestrator (slice 5's HandoffPackStageRunner) calls this in
 * a loop over the manifest. Each call is independent -- failures
 * surface via HandoffPackRenderError and are caught by the
 * orchestrator into the failed-status row of INDEX.md.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
  BrandTokens,
  DocDescriptor,
  DocRenderStatus,
  PdfTemplateConfig,
} from "@founder-os/handoff-pack-core";
import {
  getHandoffPackDocPdfPath,
} from "@founder-os/workspace-core";
import { wrapBrandedHtml } from "../css-template.js";
import { markdownToHtml } from "../markdown-engine.js";
import { renderTemplate, type TemplateContext } from "../template-engine.js";
import {
  HandoffPackRenderError,
  type PdfEngine,
  type PdfRenderResult,
} from "../types.js";

export type RenderPdfStepOpts = {
  /** Venture root, absolute. Drives the output path resolution. */
  ventureRoot: string;
  descriptor: DocDescriptor;
  tokens: BrandTokens;
  config: PdfTemplateConfig;
  /** Whichever PdfEngine implementation should land bytes on disk. */
  engine: PdfEngine;
  /**
   * Template source. Either provide an inline string (slice 2 proof +
   * tests) or an absolute path on disk. Exactly one MUST be set.
   * Path resolution against packages/handoff-pack-templates/ is the
   * caller's responsibility -- this step accepts either an absolute
   * path or one already-rooted at the templates package.
   */
  templateSource?: string;
  templatePath?: string;
  /**
   * Handlebars context. The placeholders the template references
   * MUST be present unless mode is "lenient" (tier-D default).
   * Includes brand-derived defaults (companyName, current date)
   * unless the caller has already injected them.
   */
  context: TemplateContext;
  /**
   * Override the render mode. When absent, tier-D defaults to
   * "lenient" (unresolved placeholders become TODO callouts) and
   * tier A/B/C defaults to "strict" (throw).
   */
  templateMode?: "strict" | "lenient";
};

export async function renderPdfStep(
  opts: RenderPdfStepOpts
): Promise<PdfRenderResult> {
  if (opts.templateSource == null && opts.templatePath == null) {
    throw new HandoffPackRenderError(
      opts.engine.id,
      opts.descriptor.id,
      "(unresolved)",
      new Error("renderPdfStep requires templateSource or templatePath")
    );
  }
  if (opts.templateSource != null && opts.templatePath != null) {
    throw new HandoffPackRenderError(
      opts.engine.id,
      opts.descriptor.id,
      "(unresolved)",
      new Error(
        "renderPdfStep accepts EITHER templateSource or templatePath, not both"
      )
    );
  }

  // 1. Resolve template source.
  let source: string;
  if (opts.templateSource != null) {
    source = opts.templateSource;
  } else {
    const path = resolve(opts.templatePath!);
    if (!existsSync(path)) {
      throw new HandoffPackRenderError(
        opts.engine.id,
        opts.descriptor.id,
        path,
        new Error(`template not found on disk: ${path}`)
      );
    }
    source = await readFile(path, "utf-8");
  }

  // 2. Run Handlebars-subset substitution. Tier drives mode unless
  //    the caller overrode it.
  const mode =
    opts.templateMode ?? (opts.descriptor.tier === "D" ? "lenient" : "strict");
  const templated = renderTemplate(source, opts.context, mode);

  // 3. Markdown -> HTML.
  const bodyHtml = markdownToHtml(templated.output);

  // 4. Wrap in branded shell.
  const html = wrapBrandedHtml({
    bodyHtml,
    descriptor: opts.descriptor,
    tokens: opts.tokens,
    config: opts.config,
  });

  // 5. Resolve output path via workspace-core helpers. The category
  //    folder name is intentionally identical to the slot ID today;
  //    handoff-pack-core's CATEGORY_DIR_NAMES is the source of truth
  //    if that ever changes.
  const outputPath = getHandoffPackDocPdfPath(
    opts.ventureRoot,
    opts.descriptor.category,
    opts.descriptor.slot,
    opts.descriptor.id
  );

  const status = inferStatus(opts.descriptor.tier, templated.unresolvedPlaceholders.length);

  // 6. Hand off to engine.
  return opts.engine.render({
    html,
    outputPath,
    descriptor: opts.descriptor,
    tokens: opts.tokens,
    config: opts.config,
    status,
  });
}

// ---------------------------------------------------------------------------
// Status inference
// ---------------------------------------------------------------------------

/**
 * Derive a DocRenderStatus from the doc's tier + the count of
 * unresolved placeholders the template engine surfaced.
 *
 *   tier A/B + 0 unresolved  -> "generated"
 *   tier A/B + >0 unresolved -> "partial" (LLM ran but didn't cover
 *                                          everything -- INDEX.md
 *                                          surfaces this for triage)
 *   tier C   + 0 unresolved  -> "partial" (tier C is partial by def --
 *                                          rendered with some data
 *                                          filled but not all)
 *   tier C   + >0 unresolved -> "partial"
 *   tier D                    -> "stub"   (TODO callouts are the point)
 */
function inferStatus(
  tier: DocDescriptor["tier"],
  unresolvedCount: number
): DocRenderStatus {
  if (tier === "D") return "stub";
  if (tier === "C") return "partial";
  return unresolvedCount === 0 ? "generated" : "partial";
}
