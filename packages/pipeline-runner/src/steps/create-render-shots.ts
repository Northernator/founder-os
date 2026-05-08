/**
 * Render shots step -- walks a Storyboard and dispatches each shot
 * to the right MediaProvider (per the venture's tier list + which
 * providers are currently available).
 *
 * Inputs
 * ------
 *  - manifest:      venture.yaml (id/slug)
 *  - ventureRoot:   absolute folder
 *  - fs:            injected Filesystem
 *  - storyboard:    Storyboard from createStoryboardStep
 *  - providers:     MediaProvider instances the runner has constructed
 *                   (slice 4 ships HyperFrames; later slices add Wan2,
 *                   CogVideoX, Gemini Flow, Gemini API). May be empty;
 *                   in that case every shot falls through to the
 *                   gemini_flow paste-in path.
 *  - tierList:      ordered MediaEngine list. Defaults to
 *                   PROVIDER_TIERS_DEFAULT from media-core
 *                   (hyperframes -> wan2 -> cogvideox -> gemini_flow).
 *
 * Outputs
 * -------
 *  - One MP4 per shot under 10_media/renders/<sceneId>.mp4
 *  - When a shot resolves to gemini_flow: NO render is produced;
 *    the step accumulates flow prompts and writes a single
 *    10_media/flow-prompts.md after the walk. The runner treats
 *    pendingFlow=true as a review-gate cue (founder pastes prompts
 *    into Flow, drops MP4s into renders/, re-runs).
 *
 * Failure semantics
 * -----------------
 *  - Per-shot lint/inspect/render errors from a provider are caught
 *    and surfaced in the result's perShotResults entry; the walk
 *    continues for remaining shots so the founder gets a partial
 *    receipt instead of a hard fail. The step's overall status flips
 *    to "partial" if any shot failed, "done" if all succeeded,
 *    "pending-flow" if any shot resolved to gemini_flow.
 */
import type { VentureManifest } from "@founder-os/domain";
import type {
  MediaEngine,
  MediaProvider,
  MediaResolverContext,
  Shot,
  Storyboard,
} from "@founder-os/media-core";
import {
  PROVIDER_TIERS_DEFAULT,
  resolveShotEngine,
} from "@founder-os/media-core";
import {
  getFlowPromptsPath,
  getMediaRendersDir,
} from "@founder-os/workspace-core";
import type { Filesystem } from "../fs.js";

export type CreateRenderShotsContext = {
  fs: Filesystem;
  manifest: VentureManifest;
  ventureRoot: string;
  storyboard: Storyboard;
  providers: ReadonlyArray<MediaProvider>;
  /**
   * Ordered tier list. First entry available wins. Defaults to
   * PROVIDER_TIERS_DEFAULT from media-core.
   */
  tierList?: ReadonlyArray<MediaEngine>;
  runId?: string;
};

export type ShotOutcome =
  | {
      sceneId: string;
      status: "rendered";
      engine: MediaEngine;
      path: string;
      durationSec: number;
    }
  | {
      sceneId: string;
      status: "pending-flow";
      prompt: string;
      durationSec: number;
    }
  | {
      sceneId: string;
      status: "failed";
      engine: MediaEngine | null;
      error: string;
    };

export type CreateRenderShotsResult = {
  status: "done" | "partial" | "pending-flow";
  rendersDir: string;
  flowPromptsPath?: string;
  shotCount: number;
  perShotResults: ShotOutcome[];
  successCount: number;
  failureCount: number;
  pendingFlowCount: number;
};

async function probeAvailability(
  providers: ReadonlyArray<MediaProvider>,
): Promise<Set<MediaEngine>> {
  // Probe in parallel; gather only those that report ready.
  const checks = await Promise.all(
    providers.map(async (p) => {
      try {
        return [p.name, await p.available()] as const;
      } catch {
        return [p.name, false] as const;
      }
    }),
  );
  const set = new Set<MediaEngine>();
  for (const [name, ok] of checks) {
    if (ok) set.add(name);
  }
  // gemini_flow is a "manual paste-in" pseudo-tier -- always
  // resolvable, never has a provider impl. Mark it available so
  // the resolver can fall through to it.
  set.add("gemini_flow");
  return set;
}

function renderPath(rendersDir: string, sceneId: string): string {
  return `${rendersDir}/${sceneId}.mp4`;
}

async function dispatchShot(
  shot: Shot,
  rendersDir: string,
  providersByName: Map<MediaEngine, MediaProvider>,
  resolved: MediaEngine,
): Promise<ShotOutcome> {
  if (resolved === "gemini_flow") {
    return {
      sceneId: shot.sceneId,
      status: "pending-flow",
      prompt: shot.prompt,
      durationSec: shot.durationSec,
    };
  }
  const provider = providersByName.get(resolved);
  if (!provider) {
    // Shouldn't happen -- resolver picked an engine the providers map
    // doesn't have. Treat as failed for forensics.
    return {
      sceneId: shot.sceneId,
      status: "failed",
      engine: resolved,
      error: `no provider impl for engine ${resolved}`,
    };
  }
  try {
    const result = await provider.render(shot, rendersDir);
    return {
      sceneId: shot.sceneId,
      status: "rendered",
      engine: result.engine,
      path: result.path,
      durationSec: result.durationSec,
    };
  } catch (err) {
    return {
      sceneId: shot.sceneId,
      status: "failed",
      engine: resolved,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function renderFlowPromptsMarkdown(pending: ShotOutcome[]): string {
  const header =
    "# Gemini Flow paste-in prompts\n\n" +
    "Open Flow, paste each shot's prompt, save the resulting MP4 to\n" +
    "`10_media/renders/<sceneId>.mp4`, then re-run the MEDIA stage.\n\n";
  const blocks = pending
    .filter((o): o is Extract<ShotOutcome, { status: "pending-flow" }> => o.status === "pending-flow")
    .map(
      (o) =>
        `## ${o.sceneId} (${o.durationSec}s)\n\n` +
        "Suggested filename: `renders/" + o.sceneId + ".mp4`\n\n" +
        "```\n" + o.prompt + "\n```\n",
    )
    .join("\n");
  return header + blocks;
}

export async function createRenderShotsStep(
  ctx: CreateRenderShotsContext,
): Promise<CreateRenderShotsResult> {
  const rendersDir = getMediaRendersDir(ctx.ventureRoot);
  await ctx.fs.mkdir(rendersDir);

  const tierList = ctx.tierList ?? PROVIDER_TIERS_DEFAULT;
  const providers = ctx.providers;
  const available = await probeAvailability(providers);
  const providersByName = new Map<MediaEngine, MediaProvider>();
  for (const p of providers) providersByName.set(p.name, p);

  const resolverCtx: MediaResolverContext = { tiers: tierList, available };

  const perShotResults: ShotOutcome[] = [];
  for (const shot of ctx.storyboard.shots) {
    const resolved = resolveShotEngine(shot, resolverCtx);
    if (resolved === null) {
      perShotResults.push({
        sceneId: shot.sceneId,
        status: "failed",
        engine: null,
        error:
          `no engine available for shot ${shot.sceneId} ` +
          `(hint=${shot.engineHint}, tiers=[${tierList.join(",")}])`,
      });
      continue;
    }
    perShotResults.push(await dispatchShot(shot, rendersDir, providersByName, resolved));
  }

  let successCount = 0;
  let failureCount = 0;
  let pendingFlowCount = 0;
  for (const r of perShotResults) {
    if (r.status === "rendered") successCount++;
    else if (r.status === "failed") failureCount++;
    else pendingFlowCount++;
  }

  const result: CreateRenderShotsResult = {
    status:
      pendingFlowCount > 0
        ? "pending-flow"
        : failureCount > 0
          ? "partial"
          : "done",
    rendersDir,
    shotCount: ctx.storyboard.shots.length,
    perShotResults,
    successCount,
    failureCount,
    pendingFlowCount,
  };

  if (pendingFlowCount > 0) {
    const promptsPath = getFlowPromptsPath(ctx.ventureRoot);
    await ctx.fs.writeFile(promptsPath, renderFlowPromptsMarkdown(perShotResults));
    result.flowPromptsPath = promptsPath;
  }

  return result;
}
