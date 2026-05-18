// Config-only media-edit provider (tier_1).
//
// The "skip the edit step" provider. probe() always reports available;
// prepareWorkspace()/launch()/awaitExport() are no-ops that return a
// synthetic receipt pointing at the raw MEDIA_READY reel. Useful when
// the founder explicitly opts in to MEDIA_EDIT_READY but then decides
// not to polish (or for venture configs where the stage is enabled
// for tracking but the founder ships the raw cut every time).
//
// This provider is CLIENT-SAFE (no node imports) so it can ship in the
// root barrel for any consumer that wants to type-check against the
// MediaEditProvider contract without pulling in the Node-only OpenCut
// machinery.

import type {
  EditProjectExport,
  EditedReelReceipt,
  MediaEditProbeResult,
  MediaEditProvider,
  MediaEditServerStatus,
  MediaEditSpawnResult,
} from "@founder-os/media-edit-core";

export interface CreateConfigOnlyProviderOpts {
  /**
   * Absolute path to the raw stitched reel from MEDIA_READY. The
   * receipt this provider returns points at this path so LAUNCH sees
   * a valid edited-reel artifact even though no editing happened.
   */
  rawReelPath: string;
  /** Venture slug to stamp into the receipt. */
  ventureSlug: string;
}

export function createConfigOnlyProvider(
  opts: CreateConfigOnlyProviderOpts,
): MediaEditProvider {
  async function probe(): Promise<MediaEditProbeResult> {
    return { engine: "config_only", available: true };
  }

  async function prepareWorkspace(
    _input: EditProjectExport,
  ): Promise<{ manifestPath: string; mediaDir: string }> {
    // No manifest, no media dir -- nothing to do. Return synthetic
    // paths the caller can ignore; we don't write to disk.
    return { manifestPath: "", mediaDir: "" };
  }

  async function launch(_launchOpts: {
    manifestPath: string;
  }): Promise<MediaEditSpawnResult> {
    return {
      engine: "config_only",
      spawned: true,
    };
  }

  async function awaitExport(_awaitOpts: {
    expectedPath: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<EditedReelReceipt> {
    return {
      schemaVersion: 1,
      ventureSlug: opts.ventureSlug,
      engine: "config_only",
      reelPath: opts.rawReelPath,
      exportedAt: new Date().toISOString(),
      meta: { source: "config_only", note: "raw MEDIA_READY reel" },
    };
  }

  async function teardown(): Promise<void> {
    // Nothing to clean up.
  }

  async function status(): Promise<MediaEditServerStatus> {
    return { engine: "config_only", running: false };
  }

  return {
    name: "config_only" as const,
    probe,
    prepareWorkspace,
    launch,
    awaitExport,
    teardown,
    status,
  };
}
