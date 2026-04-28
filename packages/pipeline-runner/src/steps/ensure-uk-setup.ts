import {
  type UkSetupCanvas,
  UkSetupCanvasSchema,
  type VentureManifest,
  createEmptyUkSetupCanvas,
} from "@founder-os/domain";
/**
 * ensure-uk-setup (pt.33) — deterministic step that scaffolds
 * `04_uk_business/uk-setup.json` from manifest defaults if missing.
 * Mirrors the create-brand-brief shape: no LLM, no network, idempotent
 * (skips when the file is already on disk so re-running the pipeline
 * never overwrites the founder's edits).
 *
 * The canvas is the single source of truth for UK Setup state. The
 * UI tab reads + writes it; audit rules read it; the founder edits
 * it through the tab. This step's only job is "make sure the file
 * exists with sensible defaults at pipeline-time so downstream steps
 * have something to read".
 */
import { createLogger } from "@founder-os/logger";
import { getUkSetupCanvasPath, getUkSetupDir } from "@founder-os/workspace-core";
import type { Filesystem } from "../fs.js";

const log = createLogger("pipeline-runner:ensure-uk-setup");

export type EnsureUkSetupContext = {
  fs: Filesystem;
  manifest: VentureManifest;
  ventureRoot: string;
};

export type EnsureUkSetupResult = {
  status: "done" | "skipped";
  producedArtifactIds: string[];
  /** The canvas — fresh from disk for skip, freshly-created for done. */
  canvas: UkSetupCanvas;
};

export async function ensureUkSetupStep(ctx: EnsureUkSetupContext): Promise<EnsureUkSetupResult> {
  const dir = getUkSetupDir(ctx.ventureRoot);
  await ctx.fs.mkdir(dir);

  const canvasPath = getUkSetupCanvasPath(ctx.ventureRoot);

  if (await ctx.fs.exists(canvasPath)) {
    // Existing file — read + parse so we return the canvas to the
    // orchestrator (downstream steps may want to read it). Parse
    // failures are non-fatal: log and continue with a fresh canvas
    // rather than throwing, because the founder might have edited
    // the file manually and we don't want to nuke their work.
    log.info(`UK Setup canvas already exists at ${canvasPath}`);
    try {
      const raw = await ctx.fs.readFile(canvasPath);
      const existing = UkSetupCanvasSchema.parse(JSON.parse(raw));
      return { status: "skipped", producedArtifactIds: [], canvas: existing };
    } catch (err) {
      log.warn(
        `Existing UK Setup canvas was corrupt (${err instanceof Error ? err.message : String(err)}) — leaving on disk, returning manifest defaults`
      );
      // Don't overwrite; return defaults so downstream isn't broken.
      // Audit rules will flag the file as malformed.
      return {
        status: "skipped",
        producedArtifactIds: [],
        canvas: createEmptyUkSetupCanvas(ctx.manifest.id, ctx.manifest.entityType),
      };
    }
  }

  // Fresh canvas — manifest's entityType seeds the canvas, everything
  // else starts blank for the founder to fill via the UkSetupTab.
  const canvas = createEmptyUkSetupCanvas(ctx.manifest.id, ctx.manifest.entityType);

  await ctx.fs.writeFile(canvasPath, JSON.stringify(canvas, null, 2) + "\n");
  log.info(`Created UK Setup canvas at ${canvasPath} (entityType: ${ctx.manifest.entityType})`);

  return { status: "done", producedArtifactIds: [], canvas };
}
