// OpenCut media-edit provider (tier_0).
//
// Self-hosts the OpenCut Next.js app via `bun dev` in a vendored copy,
// opens the founder's default browser at http://localhost:<port>, and
// watches an export drop directory for the manually-exported MP4.
//
// Lifecycle (matches MediaEditProvider contract from media-edit-core):
//   1. probe()            -- bun runtime + vendored OpenCut clone
//   2. prepareWorkspace() -- write clip-manifest.md under workDir
//   3. launch()           -- spawn bun dev, open browser
//   4. awaitExport()      -- poll for the export MP4 to appear
//   5. teardown()         -- SIGTERM the dev server
//   6. status()           -- whether the dev server is still running
//
// Polling vs fs.watch: we poll the export drop dir every 2s rather than
// using fs.watch. Polling sidesteps the cross-platform fs.watch quirks
// (no recursive on Linux without a flag, false positives on macOS,
// flaky on network drives) and we don't need millisecond latency here
// since the founder is exporting from a browser, not a CLI.

import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  EditProjectExport,
  EditedReelReceipt,
  MediaEditProbeResult,
  MediaEditProvider,
  MediaEditServerStatus,
  MediaEditSpawnResult,
} from "@founder-os/media-edit-core";
import {
  DEFAULT_AWAIT_EXPORT_TIMEOUT_MS,
  DEFAULT_OPENCUT_DEV_PORT,
  buildClipManifestMarkdown,
  CLIP_MANIFEST_FILENAME,
} from "@founder-os/media-edit-core";
import { probeBunRuntime, validateOpencutVendor } from "./probe.js";
import {
  openInBrowser,
  spawnBunDev,
  type SpawnBunDevResult,
} from "./spawn.js";

export interface CreateOpencutProviderOpts {
  /**
   * Absolute path to the vendored OpenCut clone (must contain a
   * package.json with "opencut" in its name, either at root or
   * apps/web/).
   */
  vendorPath: string;
  /**
   * Absolute path to the venture's edits work dir (e.g.
   * `<ventureRoot>/10_media/edits/`). The clip-manifest is written
   * here. Must exist (the runner creates it before constructing the
   * provider).
   */
  workDir: string;
  /** Dev-server port. Defaults to DEFAULT_OPENCUT_DEV_PORT (3000). */
  port?: number;
  /**
   * Hostname to point the browser at. Defaults to "localhost".
   * Useful for tests or remote dev scenarios.
   */
  host?: string;
  /**
   * Poll interval for awaitExport(), in milliseconds. Default 2000ms.
   * Smaller = lower latency; larger = less fs traffic.
   */
  pollIntervalMs?: number;
  /**
   * Stability window for awaitExport() -- the export MP4 must keep
   * the same byte size across two consecutive polls before we
   * consider it "done writing". Default 2 poll intervals.
   */
  stabilityChecks?: number;
  /**
   * Test seam: override the browser-open implementation. Real callers
   * leave this undefined.
   */
  openImpl?: (url: string) => Promise<void>;
  /**
   * Test seam: override the spawn implementation. Real callers leave
   * this undefined; tests inject a fake to avoid running `bun dev`.
   */
  spawnImpl?: (opts: {
    cwd: string;
    port: number;
  }) => Promise<SpawnBunDevResult>;
  /**
   * Test seam: override the file-stat implementation used by
   * awaitExport()'s polling. Real callers leave this undefined.
   */
  statImpl?: (p: string) => Promise<{ size: number }>;
}

export function createOpencutProvider(
  opts: CreateOpencutProviderOpts,
): MediaEditProvider {
  const port = opts.port ?? DEFAULT_OPENCUT_DEV_PORT;
  const host = opts.host ?? "localhost";
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;
  const stabilityChecks = opts.stabilityChecks ?? 2;
  const serverUrl = `http://${host}:${port}`;

  // Live state held by the provider closure.
  let child: SpawnBunDevResult["child"] | undefined;
  let pid: number | undefined;
  let startedAt: string | undefined;

  async function probe(): Promise<MediaEditProbeResult> {
    const bun = await probeBunRuntime();
    if (!bun.available) {
      const out: MediaEditProbeResult = {
        engine: "opencut",
        available: false,
      };
      if (bun.reason) out.reason = bun.reason;
      return out;
    }
    const vendor = await validateOpencutVendor(opts.vendorPath);
    if (!vendor.valid) {
      const out: MediaEditProbeResult = {
        engine: "opencut",
        available: false,
      };
      if (vendor.reason) out.reason = vendor.reason;
      if (bun.version) out.version = bun.version;
      return out;
    }
    const out: MediaEditProbeResult = {
      engine: "opencut",
      available: true,
      vendorPath: opts.vendorPath,
    };
    if (bun.version) out.version = bun.version;
    return out;
  }

  async function prepareWorkspace(
    input: EditProjectExport,
  ): Promise<{ manifestPath: string; mediaDir: string }> {
    const manifest = buildClipManifestMarkdown(input);
    const manifestPath = path.join(opts.workDir, CLIP_MANIFEST_FILENAME);
    await fs.writeFile(manifestPath, manifest, { encoding: "utf8" });
    // The mediaDir is wherever the source shots already live -- we
    // don't copy them, we just point at the directory the rendered
    // files share. Best-effort: use the first shot's parent dir, or
    // fall back to workDir.
    const firstShot = input.shots[0];
    const mediaDir = firstShot ? path.dirname(firstShot.path) : opts.workDir;
    return { manifestPath, mediaDir };
  }

  async function launch(_launchOpts: {
    manifestPath: string;
  }): Promise<MediaEditSpawnResult> {
    const spawnFn =
      opts.spawnImpl ??
      ((o: { cwd: string; port: number }) =>
        spawnBunDev({ cwd: o.cwd, port: o.port }));

    let result: SpawnBunDevResult;
    try {
      result = await spawnFn({ cwd: opts.vendorPath, port });
    } catch (err) {
      return {
        engine: "opencut",
        spawned: false,
        error: (err as Error).message,
      };
    }
    child = result.child;
    pid = result.pid;
    startedAt = new Date().toISOString();

    // Best-effort browser open. If the OS handler isn't available the
    // founder can navigate manually -- launch() still reports
    // spawned=true.
    let openedBrowser = false;
    try {
      const openOpts = opts.openImpl ? { openImpl: opts.openImpl } : {};
      openedBrowser = await openInBrowser(serverUrl, openOpts);
    } catch {
      openedBrowser = false;
    }

    return {
      engine: "opencut",
      spawned: true,
      pid: result.pid,
      serverUrl,
      serverPort: port,
      openedBrowser,
    };
  }

  async function awaitExport(awaitOpts: {
    expectedPath: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<EditedReelReceipt> {
    const timeoutMs = awaitOpts.timeoutMs ?? DEFAULT_AWAIT_EXPORT_TIMEOUT_MS;
    const statFn =
      opts.statImpl ??
      ((p: string) => fs.stat(p).then((s) => ({ size: s.size })));

    const deadline = Date.now() + timeoutMs;
    let lastSize = -1;
    let stableCount = 0;

    while (Date.now() < deadline) {
      if (awaitOpts.signal?.aborted) {
        throw new Error("awaitExport aborted by signal");
      }
      let size: number | undefined;
      try {
        const stat = await statFn(awaitOpts.expectedPath);
        size = stat.size;
      } catch {
        size = undefined;
      }
      if (size !== undefined && size > 0) {
        if (size === lastSize) {
          stableCount += 1;
          if (stableCount >= stabilityChecks) {
            return {
              schemaVersion: 1,
              ventureSlug: deriveVentureSlug(awaitOpts.expectedPath),
              engine: "opencut",
              reelPath: awaitOpts.expectedPath,
              exportedAt: new Date().toISOString(),
              meta: { sizeBytes: size },
            };
          }
        } else {
          stableCount = 0;
          lastSize = size;
        }
      } else {
        stableCount = 0;
        lastSize = -1;
      }
      await sleep(pollIntervalMs);
    }

    throw new Error(
      `awaitExport timed out after ${timeoutMs}ms waiting for ${awaitOpts.expectedPath}`,
    );
  }

  async function teardown(): Promise<void> {
    if (!child) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // already dead
    }
    child = undefined;
    pid = undefined;
    startedAt = undefined;
  }

  async function status(): Promise<MediaEditServerStatus> {
    const out: MediaEditServerStatus = {
      engine: "opencut",
      running: child !== undefined && !child.killed,
    };
    if (out.running) {
      out.url = serverUrl;
      out.port = port;
      if (pid !== undefined) out.pid = pid;
      if (startedAt !== undefined) out.startedAt = startedAt;
    }
    return out;
  }

  return {
    name: "opencut" as const,
    probe,
    prepareWorkspace,
    launch,
    awaitExport,
    teardown,
    status,
  };
}

// --- internals --------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Best-effort venture-slug recovery from an export path. The runner is
 * the source of truth, but if the receipt is read in isolation
 * (without the runner) we still want a plausible slug. We pull the
 * <ventureRoot>'s leaf name out of paths like
 * `.../<slug>/10_media/exports/edited/final-reel.mp4`.
 */
function deriveVentureSlug(expectedPath: string): string {
  const segments = expectedPath.split(/[\\/]/);
  const mediaIdx = segments.findIndex((s) => s === "10_media");
  if (mediaIdx > 0) {
    const slug = segments[mediaIdx - 1];
    if (slug) return slug;
  }
  return "unknown";
}
