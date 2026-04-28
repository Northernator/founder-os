import {
  ProductSpecCanvasSchema,
  type ScreensCanvas,
  ScreensCanvasSchema,
  type VentureManifest,
  createEmptyScreensCanvas,
  renderScreensMarkdown,
} from "@founder-os/domain";
/**
 * ensure-screens (pt.43) — deterministic step that scaffolds the
 * Screens canvas at `06_product/wireframes/screens-canvas.json` if
 * missing, then renders the derived `screens.md` view from the
 * canvas + spec snapshot on every run.
 *
 * Mirrors the ensure-spec (pt.41c) pattern exactly:
 *   1. Canvas-first JSON — the structured source of truth, edited
 *      via the ScreensTab in the desktop app.
 *   2. Markdown derivation — the human-friendly read-only view
 *      regenerated from the canvas on every pipeline run.
 *
 * Reads the spec canvas (best-effort) so the rendered markdown can
 * resolve feature/entity ids to their human names. If the spec is
 * missing or malformed, we still scaffold the screens canvas and
 * render with raw ids — the spec audit will already be flagging the
 * missing/invalid spec separately.
 *
 * Corrupt-file guard: if the existing screens canvas JSON fails Zod
 * parse, we LEAVE the file on disk (don't nuke founder edits) and
 * skip the markdown rewrite (don't clobber a hand-edited .md from a
 * defaulted canvas). Same policy as ensure-spec / ensure-uk-setup.
 *
 * Naming: the stage value in `VENTURE_STAGE_ORDER` is still
 * `WIREFRAME_READY` (legacy) and the folder is
 * `06_product/wireframes/`, but the canvas + UI are scoped to
 * "Screens" — see packages/domain/src/screens.ts for the
 * deliberately-narrowed scope.
 */
import { createLogger } from "@founder-os/logger";
import {
  getScreensCanvasPath,
  getScreensMarkdownPath,
  getSpecCanvasPath,
  getWireframesDir,
} from "@founder-os/workspace-core";
import type { Filesystem } from "../fs.js";

const log = createLogger("pipeline-runner:ensure-screens");

export type EnsureScreensContext = {
  fs: Filesystem;
  manifest: VentureManifest;
  ventureRoot: string;
};

export type EnsureScreensResult = {
  status: "done" | "skipped";
  producedArtifactIds: string[];
  /** The canvas — fresh from disk for skip, freshly-created for done. */
  canvas: ScreensCanvas;
};

export async function ensureScreensStep(ctx: EnsureScreensContext): Promise<EnsureScreensResult> {
  const dir = getWireframesDir(ctx.ventureRoot);
  await ctx.fs.mkdir(dir);

  const canvasPath = getScreensCanvasPath(ctx.ventureRoot);
  const mdPath = getScreensMarkdownPath(ctx.ventureRoot);

  let canvas: ScreensCanvas;
  let status: "done" | "skipped" = "done";

  if (await ctx.fs.exists(canvasPath)) {
    log.info(`Screens canvas already exists at ${canvasPath}`);
    try {
      const raw = await ctx.fs.readFile(canvasPath);
      canvas = ScreensCanvasSchema.parse(JSON.parse(raw));
      status = "skipped";
    } catch (err) {
      log.warn(
        `Existing screens canvas was corrupt (${err instanceof Error ? err.message : String(err)}) — leaving on disk, returning empty canvas`
      );
      // Don't overwrite — return defaults but skip the markdown
      // rewrite too. Audit rules will flag the malformed file.
      // Same policy as ensure-spec's corrupt-file guard.
      canvas = createEmptyScreensCanvas(ctx.manifest.id);
      return {
        status: "skipped",
        producedArtifactIds: [],
        canvas,
      };
    }
  } else {
    canvas = createEmptyScreensCanvas(ctx.manifest.id);
    await ctx.fs.writeFile(canvasPath, JSON.stringify(canvas, null, 2) + "\n");
    log.info(`Created screens canvas at ${canvasPath}`);
  }

  // Best-effort spec read for the markdown render — lets us resolve
  // featureIds / entityIds to their human names in the rendered .md.
  // Missing or malformed spec is non-fatal; we render with raw ids
  // and the spec audit will flag the underlying issue separately.
  const specCanvasPath = getSpecCanvasPath(ctx.ventureRoot);
  let specSnapshot:
    | {
        features: Array<{ id: string; name: string }>;
        dataModel: { entities: Array<{ id: string; name: string }> };
      }
    | undefined;
  if (await ctx.fs.exists(specCanvasPath)) {
    try {
      const rawSpec = await ctx.fs.readFile(specCanvasPath);
      const parsed = ProductSpecCanvasSchema.safeParse(JSON.parse(rawSpec));
      if (parsed.success) {
        specSnapshot = {
          features: parsed.data.features.map((f) => ({
            id: f.id,
            name: f.name,
          })),
          dataModel: {
            entities: parsed.data.dataModel.entities.map((e) => ({
              id: e.id,
              name: e.name,
            })),
          },
        };
      } else {
        log.warn("Spec canvas failed Zod parse — rendering screens.md with raw feature/entity ids");
      }
    } catch (err) {
      log.warn(
        `Spec canvas read failed (${err instanceof Error ? err.message : String(err)}) — rendering screens.md with raw ids`
      );
    }
  }

  // Always (re)render the markdown from the current canvas. The .md
  // is a derived artifact — direct edits are lost on the next
  // pipeline run. The header in the rendered output makes that clear.
  const md = renderScreensMarkdown(canvas, {
    ventureName: ctx.manifest.name,
    spec: specSnapshot,
  });
  await ctx.fs.writeFile(mdPath, md);

  return {
    status,
    producedArtifactIds: [],
    canvas,
  };
}
