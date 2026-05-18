/**
 * awaitOpencutExportStep -- step 3 of MEDIA_EDIT_READY real path.
 *
 * Waits for the founder to export their polished reel out of OpenCut
 * to disk, then writes the edit-receipt.json artifact.
 *
 * For the opencut provider this is a poll-based watch on
 * <expectedPath>'s size-stability; for config_only it's a synthetic
 * receipt that points back at the raw MEDIA_READY reel (no waiting).
 *
 * Inputs
 * ------
 *  - manifest:     venture.yaml
 *  - ventureRoot:  absolute folder
 *  - fs:           injected Filesystem (writes edit-receipt.json)
 *  - runId:        the stage run id
 *  - provider:     a MediaEditProvider
 *  - expectedPath: absolute path the founder is told to export to
 *                  (matches EditProjectExport.exportTargetPath from
 *                  step 1)
 *  - timeoutMs:    optional, forwarded to provider.awaitExport
 *  - signal:       optional AbortSignal for the founder to cancel
 *
 * Behaviour
 * ---------
 *  - On timeout the provider throws -- the step catches and surfaces
 *    status:"timeout" with the error message. The runner converts
 *    this into a pending-state review gate so the founder can resume
 *    the next session by re-running MEDIA_EDIT.
 *  - On signal abort the provider throws -- surfaced as
 *    status:"aborted" so the runner reports the run cleanly without
 *    marking the stage failed.
 *  - The edit-receipt.json is written even when the provider returned
 *    a synthetic receipt (config_only) -- LAUNCH reads the path field
 *    to know which reel to use.
 */
import type { VentureManifest } from "@founder-os/domain";
import type {
  EditedReelReceipt,
  MediaEditProvider,
} from "@founder-os/media-edit-core";
import { getEditReceiptPath } from "@founder-os/workspace-core";
import type { Filesystem } from "../fs.js";

export type AwaitOpencutExportStepCtx = {
  manifest: VentureManifest;
  ventureRoot: string;
  fs: Filesystem;
  runId: string;
  provider: MediaEditProvider;
  expectedPath: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type AwaitOpencutExportStepResult =
  | {
      status: "done";
      receiptPath: string;
      reelPath: string;
      durationSec?: number;
    }
  | { status: "timeout"; error: string }
  | { status: "aborted"; error: string }
  | { status: "failed"; error: string };

export async function awaitOpencutExportStep(
  ctx: AwaitOpencutExportStepCtx,
): Promise<AwaitOpencutExportStepResult> {
  let receipt: EditedReelReceipt;
  try {
    const awaitOpts: {
      expectedPath: string;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = { expectedPath: ctx.expectedPath };
    if (ctx.timeoutMs !== undefined) awaitOpts.timeoutMs = ctx.timeoutMs;
    if (ctx.signal !== undefined) awaitOpts.signal = ctx.signal;
    receipt = await ctx.provider.awaitExport(awaitOpts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("abort")) {
      return { status: "aborted", error: msg };
    }
    if (msg.toLowerCase().includes("time")) {
      return { status: "timeout", error: msg };
    }
    return { status: "failed", error: msg };
  }

  const receiptPath = getEditReceiptPath(ctx.ventureRoot);
  await ctx.fs.writeFile(
    receiptPath,
    `${JSON.stringify(receipt, null, 2)}\n`,
  );

  const out: AwaitOpencutExportStepResult = {
    status: "done",
    receiptPath,
    reelPath: receipt.reelPath,
  };
  if (receipt.durationSec !== undefined) out.durationSec = receipt.durationSec;
  return out;
}
