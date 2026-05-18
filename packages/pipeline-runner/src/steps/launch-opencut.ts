/**
 * launchOpencutStep -- step 2 of MEDIA_EDIT_READY real path.
 *
 * Asks the provider to spin up its editor surface. For the opencut
 * provider that means starting `bun dev` in the vendored OpenCut copy
 * and opening the founder's default browser at http://localhost:<port>;
 * for config_only it's a no-op returning spawned=true with no server
 * fields.
 *
 * Inputs
 * ------
 *  - manifest:     venture.yaml
 *  - ventureRoot:  absolute folder
 *  - fs:           injected Filesystem (unused here but kept for
 *                  parity with other step ctxs)
 *  - runId:        the stage run id
 *  - provider:     a MediaEditProvider
 *  - manifestPath: absolute path to clip-manifest.md from step 1
 *
 * Behaviour
 * ---------
 *  - Forwards manifestPath to provider.launch({ manifestPath }).
 *  - On opencut spawn failure (ENOENT, port conflict, bun missing) the
 *    provider returns spawned:false with an error string -- the step
 *    surfaces that as status:"failed" so the runner can fail cleanly
 *    without leaving the founder thinking the server is up.
 *  - When the provider doesn't spawn anything (config_only) but
 *    reports spawned:true, surface as status:"skipped" -- the runner
 *    can skip awaitExport and head straight to the receipt.
 */
import type { VentureManifest } from "@founder-os/domain";
import type {
  MediaEditProvider,
  MediaEditSpawnResult,
} from "@founder-os/media-edit-core";
import type { Filesystem } from "../fs.js";

export type LaunchOpencutStepCtx = {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
  runId: string;
  provider: MediaEditProvider;
  manifestPath: string;
};

export type LaunchOpencutStepResult =
  | {
      status: "done";
      spawned: true;
      pid?: number;
      serverUrl: string;
      serverPort: number;
      openedBrowser: boolean;
    }
  | {
      status: "skipped";
      spawned: true;
      reason: string;
    }
  | {
      status: "failed";
      spawned: false;
      error: string;
    };

export async function launchOpencutStep(
  ctx: LaunchOpencutStepCtx,
): Promise<LaunchOpencutStepResult> {
  let result: MediaEditSpawnResult;
  try {
    result = await ctx.provider.launch({ manifestPath: ctx.manifestPath });
  } catch (err) {
    return {
      status: "failed",
      spawned: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!result.spawned) {
    return {
      status: "failed",
      spawned: false,
      error: result.error ?? "Provider reported spawned=false with no error message",
    };
  }

  // No server fields -> config_only / stub returning spawned=true.
  if (!result.serverUrl || result.serverPort === undefined) {
    return {
      status: "skipped",
      spawned: true,
      reason: `Provider "${ctx.provider.name}" spawned without a server (no URL/port).`,
    };
  }

  const out: LaunchOpencutStepResult = {
    status: "done",
    spawned: true,
    serverUrl: result.serverUrl,
    serverPort: result.serverPort,
    openedBrowser: result.openedBrowser ?? false,
  };
  if (result.pid !== undefined) out.pid = result.pid;
  return out;
}
