/**
 * createOpencutWorkspaceStep -- step 1 of MEDIA_EDIT_READY real path.
 *
 * Reads storyboard.json from MEDIA_READY's output, derives an
 * engine-agnostic EditProjectExport (one EditProjectSourceShot per
 * Storyboard.Shot), and asks the provider to write the editor's
 * on-disk hints. For the opencut provider that means writing
 * clip-manifest.md under 10_media/edits/; for config_only it's a
 * no-op returning empty paths.
 *
 * Brand hints are deliberately empty in slice 4 -- slice 5 (desktop
 * wiring) populates them by reading brand-brief.json. The contract
 * marks brandHints optional so this degrades gracefully.
 *
 * Inputs
 * ------
 *  - manifest:           venture.yaml
 *  - ventureRoot:        absolute folder
 *  - fs:                 injected Filesystem
 *  - runId:              the stage run id
 *  - provider:           a MediaEditProvider (real opencut or config_only stub)
 *  - exportTargetPath:   absolute path where the founder is told to drop
 *                        the polished MP4 (typically
 *                        <ventureRoot>/10_media/exports/edited/final-reel.mp4)
 *  - storyboard:         optional inline Storyboard; when absent the
 *                        step reads it from getStoryboardJsonPath
 *
 * Behaviour
 * ---------
 *  - Reads storyboard from disk when not injected. Missing/malformed
 *    storyboard short-circuits the step with status:"failed" so the
 *    runner can surface MEDIA_EDIT_NO_UPSTREAM upstream of any provider
 *    work.
 *  - Calls provider.prepareWorkspace(export) -- the provider is the
 *    single source of truth for what gets written. config_only's
 *    no-op returns empty strings, surfaced as status:"skipped".
 *  - Idempotent: re-running overwrites the manifest with the current
 *    storyboard contents.
 */
import type { VentureManifest } from "@founder-os/domain";
import type {
  EditProjectExport,
  EditProjectSourceShot,
  MediaEditProvider,
} from "@founder-os/media-edit-core";
import {
  parseStoryboard,
  type Storyboard,
} from "@founder-os/media-core";
import { getStoryboardJsonPath } from "@founder-os/workspace-core";
import type { Filesystem } from "../fs.js";

export type CreateOpencutWorkspaceStepCtx = {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
  runId: string;
  provider: MediaEditProvider;
  exportTargetPath: string;
  storyboard?: Storyboard;
};

export type CreateOpencutWorkspaceStepResult =
  | {
      status: "done";
      manifestPath: string;
      mediaDir: string;
      shotCount: number;
      exportTargetPath: string;
    }
  | {
      status: "skipped";
      reason: string;
    }
  | {
      status: "failed";
      reason: string;
    };

export async function createOpencutWorkspaceStep(
  ctx: CreateOpencutWorkspaceStepCtx,
): Promise<CreateOpencutWorkspaceStepResult> {
  const storyboard = await loadStoryboard(ctx);
  if (storyboard === null) {
    return {
      status: "failed",
      reason: `No storyboard.json under ${getStoryboardJsonPath(ctx.ventureRoot)} -- run MEDIA stage first.`,
    };
  }
  if (storyboard.shots.length === 0) {
    return {
      status: "failed",
      reason: "Storyboard has zero shots; nothing for the founder to edit.",
    };
  }

  const shots: EditProjectSourceShot[] = storyboard.shots.map((shot) => {
    const entry: EditProjectSourceShot = {
      shotId: shot.sceneId,
      path: `${ctx.ventureRoot.replace(/[\\/]+$/, "")}/10_media/renders/${shot.sceneId}.mp4`,
      durationSec: shot.durationSec,
    };
    return entry;
  });

  const exportData: EditProjectExport = {
    schemaVersion: 1,
    ventureSlug: ctx.manifest.slug,
    engine: ctx.provider.name,
    shots,
    exportTargetPath: ctx.exportTargetPath,
    generatedAt: new Date().toISOString(),
  };

  const prepared = await ctx.provider.prepareWorkspace(exportData);

  // config_only returns empty strings -- surface as skipped so the
  // runner doesn't think a manifest was written.
  if (!prepared.manifestPath || !prepared.mediaDir) {
    return {
      status: "skipped",
      reason: `Provider "${ctx.provider.name}" did not write a workspace (config_only or stub).`,
    };
  }

  return {
    status: "done",
    manifestPath: prepared.manifestPath,
    mediaDir: prepared.mediaDir,
    shotCount: shots.length,
    exportTargetPath: ctx.exportTargetPath,
  };
}

async function loadStoryboard(
  ctx: CreateOpencutWorkspaceStepCtx,
): Promise<Storyboard | null> {
  if (ctx.storyboard) return ctx.storyboard;
  const path = getStoryboardJsonPath(ctx.ventureRoot);
  if (!(await ctx.fs.exists(path))) return null;
  try {
    const raw = await ctx.fs.readFile(path);
    return parseStoryboard(JSON.parse(raw));
  } catch {
    return null;
  }
}
