import {
  type ProductSpecCanvas,
  ProductSpecCanvasSchema,
  type VentureManifest,
  createEmptyProductSpecCanvas,
  renderProductSpecMarkdown,
} from "@founder-os/domain";
/**
 * ensure-spec (pt.41) — deterministic step that scaffolds
 * `06_product/specs/spec-canvas.json` if missing, then renders the
 * derived `product-spec.md` view from the canvas on every run.
 *
 * Pre-pt.41 this step generated a static markdown template with
 * placeholder sections. That's now replaced by:
 *   1. Canvas-first JSON — the structured source of truth, edited
 *      via the SpecTab in the desktop app.
 *   2. Markdown derivation — the human-friendly read-only view
 *      regenerated from the canvas on every pipeline run.
 *
 * Mirrors the ensure-uk-setup pattern (pt.33d): no LLM, no network,
 * idempotent for the canvas (skips when on disk so re-running never
 * overwrites founder edits), but ALWAYS rewrites the markdown so a
 * canvas edit eventually shows up in the .md too.
 *
 * Corrupt-file guard: if the existing canvas JSON fails Zod parse,
 * the step LEAVES the file on disk and returns an empty canvas.
 * Audit rules will flag the malformed file separately. Same "don't
 * nuke user work" policy as the venture manifest validator and the
 * UK Setup canvas guard.
 */
import { createLogger } from "@founder-os/logger";
import {
  getProductSpecMarkdownPath,
  getSpecCanvasPath,
  getSpecsDir,
} from "@founder-os/workspace-core";
import type { Filesystem } from "../fs.js";

const log = createLogger("pipeline-runner:ensure-spec");

export type EnsureSpecContext = {
  fs: Filesystem;
  manifest: VentureManifest;
  ventureRoot: string;
};

export type EnsureSpecResult = {
  status: "done" | "skipped";
  producedArtifactIds: string[];
  /** The canvas — fresh from disk for skip, freshly-created for done. */
  canvas: ProductSpecCanvas;
};

export async function ensureSpecStep(ctx: EnsureSpecContext): Promise<EnsureSpecResult> {
  const dir = getSpecsDir(ctx.ventureRoot);
  await ctx.fs.mkdir(dir);

  const canvasPath = getSpecCanvasPath(ctx.ventureRoot);
  const mdPath = getProductSpecMarkdownPath(ctx.ventureRoot);

  let canvas: ProductSpecCanvas;
  let status: "done" | "skipped" = "done";

  if (await ctx.fs.exists(canvasPath)) {
    log.info(`Spec canvas already exists at ${canvasPath}`);
    try {
      const raw = await ctx.fs.readFile(canvasPath);
      canvas = ProductSpecCanvasSchema.parse(JSON.parse(raw));
      status = "skipped";
    } catch (err) {
      log.warn(
        `Existing spec canvas was corrupt (${err instanceof Error ? err.message : String(err)}) — leaving on disk, returning empty canvas`
      );
      // Don't overwrite — return defaults so the markdown derivation
      // below still runs. Audit rules will flag the malformed file.
      canvas = createEmptyProductSpecCanvas(ctx.manifest.id);
      // Skip the markdown rewrite too — the derived view from a
      // defaulted canvas would clobber whatever the founder may have
      // hand-edited at the .md level. Better to surface the corruption
      // via audit and let them fix the canvas first.
      return {
        status: "skipped",
        producedArtifactIds: [],
        canvas,
      };
    }
  } else {
    canvas = createEmptyProductSpecCanvas(ctx.manifest.id);
    await ctx.fs.writeFile(canvasPath, JSON.stringify(canvas, null, 2) + "\n");
    log.info(`Created spec canvas at ${canvasPath}`);
  }

  // Always (re)render the markdown view from the current canvas.
  // The .md is a derived artifact — edits made directly to the .md
  // are lost on the next pipeline run. The pipeline header in the
  // rendered output makes that clear.
  const md = renderProductSpecMarkdown(canvas, {
    ventureName: ctx.manifest.name,
  });
  await ctx.fs.writeFile(mdPath, md);

  return {
    status,
    producedArtifactIds: [],
    canvas,
  };
}
