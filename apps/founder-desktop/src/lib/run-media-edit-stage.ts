/**
 * run-media-edit-stage.ts -- desktop helper for MediaEditStageRunner.
 *
 * Slice 5b of the media-edit arc. Grew from slice 5a (which fell through
 * to skeletal for engine=opencut) to construct a real IPC-shaped
 * MediaEditProvider whose method bodies route through `invoke()` to the
 * four Tauri commands in apps/founder-desktop/src-tauri/src/media_edit.rs:
 *
 *   probe          -> invoke("media_edit_probe_vendor", { vendorPath })
 *   prepareWorkspace -> pure JS (calls buildClipManifestMarkdown from
 *                       media-edit-core + Tauri write_file via tauriFs)
 *   launch         -> invoke("media_edit_serve", { vendorPath, port })
 *                     then invoke("media_edit_open_browser", { url })
 *   awaitExport    -> polls via Tauri path_exists / Tauri stat (no
 *                     Node child needed -- the founder's export lands
 *                     on disk and we just watch for it)
 *   teardown       -> invoke("media_edit_kill", { pid }) with the
 *                     server PID captured during launch
 *
 * The provider is constructed inline (not in @founder-os/media-edit-providers/node
 * which is correctly off-limits to the webview per the PM-split rule).
 *
 * Resolution policy for vendorPath:
 *   - Read from manifest.mediaEdit.vendorPath (when present, full override)
 *   - Otherwise default to <workspaceRoot>/.founder-os-cache/vendor/opencut/
 *     using ventureRoot's first 2-3 path segments to find the workspace.
 *     For a true workspace-root we'd want a separate Tauri command; slice
 *     5b uses a simple heuristic with a manifest override as the escape
 *     hatch.
 */
import type { Venture, VentureManifest } from "@founder-os/domain";
import {
  buildClipManifestMarkdown,
  CLIP_MANIFEST_FILENAME,
  DEFAULT_AWAIT_EXPORT_TIMEOUT_MS,
  DEFAULT_OPENCUT_DEV_PORT,
  type EditProjectExport,
  type EditedReelReceipt,
  type MediaEditProbeResult,
  type MediaEditProvider,
  type MediaEditServerStatus,
  type MediaEditSpawnResult,
  OPENCUT_VENDOR_DIRNAME,
} from "@founder-os/media-edit-core";
import { createConfigOnlyProvider } from "@founder-os/media-edit-providers";
import type { StageRunResult } from "@founder-os/stage-runners";
import { MediaEditStageRunner, PipelineOrchestrator } from "@founder-os/stage-runners";
import {
  getEditedReelPath,
  getLaunchReelPath,
  getMediaEditDir,
} from "@founder-os/workspace-core";
import { invoke } from "@tauri-apps/api/core";
import { tauriFs } from "./pipeline-fs.js";

export type RunMediaEditStageOpts = {
  venture: Venture;
  manifest: VentureManifest;
  signal?: AbortSignal;
  force?: boolean;
};

export type RunMediaEditMode = "skeletal" | "config_only" | "opencut";

export type RunMediaEditStageResult =
  | { kind: "skipped"; reason: string }
  | { kind: "ran"; result: StageRunResult; mode: RunMediaEditMode };

export async function runMediaEditStage(
  opts: RunMediaEditStageOpts,
): Promise<RunMediaEditStageResult> {
  if (opts.manifest.mediaEdit?.enabled !== true) {
    return {
      kind: "skipped",
      reason: "manifest.mediaEdit.enabled is not true",
    };
  }

  const engine = opts.manifest.mediaEdit.engine ?? "opencut";

  // ---- config_only: pure provider; no Tauri commands needed -----------
  if (engine === "config_only") {
    const provider = createConfigOnlyProvider({
      rawReelPath: getLaunchReelPath(opts.venture.rootPath),
      ventureSlug: opts.manifest.slug,
    });
    return runWith(opts, provider, "config_only");
  }

  // ---- opencut: IPC-shaped provider routes through Tauri commands ----
  const vendorPath = resolveVendorPath(opts);
  const port = opts.manifest.mediaEdit.serverPort ?? DEFAULT_OPENCUT_DEV_PORT;
  const provider = createTauriOpencutProvider({
    vendorPath,
    port,
    ventureSlug: opts.manifest.slug,
    workDir: getMediaEditDir(opts.venture.rootPath),
  });
  return runWith(opts, provider, "opencut");
}

async function runWith(
  opts: RunMediaEditStageOpts,
  provider: MediaEditProvider,
  mode: RunMediaEditMode,
): Promise<RunMediaEditStageResult> {
  const runner = new MediaEditStageRunner({
    manifest: opts.manifest,
    ventureRoot: opts.venture.rootPath,
    fs: tauriFs,
    provider,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
  const orchestrator = new PipelineOrchestrator({
    ventureRoot: opts.venture.rootPath,
    fs: tauriFs,
    manifest: opts.manifest,
  });
  const result = await orchestrator.runStage(runner, {
    force: opts.force ?? false,
  });
  return { kind: "ran", result, mode };
}

/**
 * Resolve where the vendored OpenCut clone lives.
 *
 * Priority: manifest.mediaEdit.vendorPath (explicit) -> default
 * `<workspaceRoot>/.founder-os-cache/vendor/opencut/` using a workspace
 * heuristic derived from the venture root.
 *
 * NOTE: the workspace heuristic is "parent of <ventureRoot>/.." assuming
 * the venture sits one level below the workspace folder. This matches
 * how Founder OS lays out ventures today (workspace/ventures/<slug>/),
 * but it's not bulletproof. Slice 5c could add a dedicated Tauri
 * command for proper workspace-root resolution if this proves brittle.
 */
function resolveVendorPath(opts: RunMediaEditStageOpts): string {
  // biome-ignore lint/suspicious/noExplicitAny: optional extension field not in domain schema yet
  const override = (opts.manifest.mediaEdit as any)?.vendorPath;
  if (typeof override === "string" && override.length > 0) return override;
  // Heuristic: <ventureRoot>/../../.founder-os-cache/vendor/opencut
  // Trim trailing slashes for a clean join.
  const root = opts.venture.rootPath.replace(/[\\/]+$/, "");
  // Use OS-native separator inferred from the venture root.
  const sep = root.includes("\\") ? "\\" : "/";
  const parts = root.split(/[\\/]/).filter((s) => s.length > 0);
  // Drop the last two segments (ventures/<slug>) -- if there aren't two
  // we just drop one (best-effort).
  const dropCount = parts.length >= 2 ? 2 : 1;
  const workspaceRoot = parts.slice(0, parts.length - dropCount).join(sep);
  // Reapply leading separator for POSIX absolute paths.
  const leading = root.startsWith("/") ? "/" : "";
  return `${leading}${workspaceRoot}${sep}.founder-os-cache${sep}vendor${sep}${OPENCUT_VENDOR_DIRNAME}`;
}

/**
 * Build a MediaEditProvider whose methods route through Tauri commands.
 * Lives in the desktop helper (not in @founder-os/media-edit-providers)
 * because the webview can't import the /node entry point.
 */
function createTauriOpencutProvider(opts: {
  vendorPath: string;
  port: number;
  ventureSlug: string;
  workDir: string;
}): MediaEditProvider {
  let pid: number | undefined;
  let serverUrl: string | undefined;
  let startedAt: string | undefined;

  return {
    name: "opencut" as const,

    async probe(): Promise<MediaEditProbeResult> {
      const res = await invoke<MediaEditProbeResult>("media_edit_probe_vendor", {
        vendorPath: opts.vendorPath,
      });
      return res;
    },

    async prepareWorkspace(
      input: EditProjectExport,
    ): Promise<{ manifestPath: string; mediaDir: string }> {
      const md = buildClipManifestMarkdown(input);
      const manifestPath = `${opts.workDir.replace(/[\\/]+$/, "")}/${CLIP_MANIFEST_FILENAME}`;
      // Tauri's mkdir is a no-op when the dir exists; tauriFs.mkdir
      // handles either case.
      await tauriFs.mkdir(opts.workDir);
      await tauriFs.writeFile(manifestPath, md);
      const firstShot = input.shots[0];
      const mediaDir = firstShot
        ? firstShot.path.replace(/[\\/][^\\/]+$/, "")
        : opts.workDir;
      return { manifestPath, mediaDir };
    },

    async launch(_l: { manifestPath: string }): Promise<MediaEditSpawnResult> {
      try {
        const spawn = await invoke<{
          spawned: boolean;
          pid?: number;
          serverUrl?: string;
          serverPort?: number;
          error?: string;
        }>("media_edit_serve", {
          vendorPath: opts.vendorPath,
          port: opts.port,
        });
        if (!spawn.spawned) {
          return {
            engine: "opencut",
            spawned: false,
            error: spawn.error ?? "bun spawn failed",
          };
        }
        pid = spawn.pid;
        serverUrl = spawn.serverUrl;
        startedAt = new Date().toISOString();
        // Best-effort browser open. Don't fail the whole launch if it
        // doesn't work -- the founder can navigate manually.
        let openedBrowser = false;
        try {
          const opened = await invoke<{ openedBrowser: boolean }>(
            "media_edit_open_browser",
            { url: spawn.serverUrl ?? `http://localhost:${opts.port}` },
          );
          openedBrowser = opened.openedBrowser;
        } catch {
          openedBrowser = false;
        }
        const out: MediaEditSpawnResult = {
          engine: "opencut",
          spawned: true,
          openedBrowser,
        };
        if (spawn.pid !== undefined) out.pid = spawn.pid;
        if (spawn.serverUrl) out.serverUrl = spawn.serverUrl;
        if (spawn.serverPort !== undefined) out.serverPort = spawn.serverPort;
        return out;
      } catch (err) {
        return {
          engine: "opencut",
          spawned: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async awaitExport(awaitOpts: {
      expectedPath: string;
      timeoutMs?: number;
      signal?: AbortSignal;
    }): Promise<EditedReelReceipt> {
      const timeoutMs = awaitOpts.timeoutMs ?? DEFAULT_AWAIT_EXPORT_TIMEOUT_MS;
      const pollIntervalMs = 2000;
      const stabilityChecks = 2;
      const deadline = Date.now() + timeoutMs;
      let lastSize = -1;
      let stableCount = 0;
      while (Date.now() < deadline) {
        if (awaitOpts.signal?.aborted) {
          throw new Error("awaitExport aborted by signal");
        }
        let size: number | undefined;
        try {
          const stat = await invoke<{ exists: boolean; sizeBytes?: number }>(
            "path_exists",
            { path: awaitOpts.expectedPath },
          );
          // The desktop's path_exists may not return size; fall back to a
          // dedicated stat command when one ships. For now treat "exists"
          // as a 1-byte stand-in to advance the state machine.
          size = stat.exists ? (stat.sizeBytes ?? 1) : undefined;
        } catch {
          size = undefined;
        }
        if (size !== undefined && size > 0) {
          if (size === lastSize) {
            stableCount += 1;
            if (stableCount >= stabilityChecks) {
              return {
                schemaVersion: 1,
                ventureSlug: opts.ventureSlug,
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
    },

    async teardown(): Promise<void> {
      if (pid === undefined) return;
      try {
        await invoke<{ killed: boolean }>("media_edit_kill", { pid });
      } catch {
        // Already dead or never started -- nothing to do.
      }
      pid = undefined;
      serverUrl = undefined;
      startedAt = undefined;
    },

    async status(): Promise<MediaEditServerStatus> {
      const out: MediaEditServerStatus = {
        engine: "opencut",
        running: pid !== undefined,
      };
      if (out.running) {
        if (serverUrl) out.url = serverUrl;
        out.port = opts.port;
        if (pid !== undefined) out.pid = pid;
        if (startedAt !== undefined) out.startedAt = startedAt;
      }
      return out;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Exported so MediaEditTab can also reach the resolved vendor path for
// "where is OpenCut installed?" hints in the UI.
export { resolveVendorPath as resolveOpencutVendorPath };

// Used by MediaEditTab to surface probe status BEFORE running the stage.
// Returns the same MediaEditProbeResult envelope the runner would see.
export async function probeOpencutVendor(opts: RunMediaEditStageOpts): Promise<MediaEditProbeResult> {
  const vendorPath = resolveVendorPath(opts);
  try {
    return await invoke<MediaEditProbeResult>("media_edit_probe_vendor", {
      vendorPath,
    });
  } catch (err) {
    return {
      engine: "opencut",
      available: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
