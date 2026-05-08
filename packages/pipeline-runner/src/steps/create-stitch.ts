/**
 * Stitch step -- ffmpeg-concats per-shot MP4s into the final
 * launch reel under 10_media/exports/launch-reel.mp4.
 *
 * Inputs
 * ------
 *  - manifest:      venture.yaml
 *  - ventureRoot:   absolute folder
 *  - fs:            injected Filesystem (for mkdir / write the
 *                   ffmpeg concat list)
 *  - shotPaths:     absolute paths to per-shot MP4s in render order
 *                   (the runner passes the storyboard.shots order so
 *                   shot N+1 follows shot N in the reel)
 *  - ffmpegBinary:  binary name or path. Default "ffmpeg" (must be on
 *                   PATH; HyperFrames already requires it as a peer
 *                   so this is a safe assumption when tier_0 ran)
 *  - timeoutMs:     hard timeout. Default 180_000 (concat is fast
 *                   when sources have identical codecs)
 *  - spawn:         optional injected spawn function for tests; tests
 *                   pass a fake that doesn't shell out. Production
 *                   path uses node:child_process.spawn.
 *
 * Outputs
 * -------
 *  - launch-reel.mp4 under 10_media/exports/
 *  - concat-list.txt under 10_media/exports/ (ffmpeg's concat-demuxer
 *    input list; kept around for debugging, overwritten on re-run)
 *
 * Behaviour
 * ---------
 *  - When all shots came from the same provider (e.g. HyperFrames),
 *    sources have identical codec/resolution/fps. We use
 *    `-f concat -safe 0 -i list.txt -c copy` for stream-copy (fast,
 *    no re-encode). Mixed-source support (slice 5+ when Wan2 etc.
 *    come online) will need a filter_complex re-encode path.
 *  - Empty shotPaths is treated as success-with-zero-frames (no
 *    reel written). Caller decides whether to flag this upstream.
 *  - ffmpeg failures throw; the runner catches and surfaces as
 *    MEDIA_STEP_THREW with the error code so the desktop's
 *    FailedRunBanner can show the stderr tail.
 */
import type { VentureManifest } from "@founder-os/domain";
import {
  getLaunchReelPath,
  getMediaExportsDir,
} from "@founder-os/workspace-core";
import type { Filesystem } from "../fs.js";

export interface StitchSpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type StitchSpawnFn = (
  binary: string,
  args: ReadonlyArray<string>,
  opts: { cwd?: string; timeoutMs?: number },
) => Promise<StitchSpawnResult>;

export type CreateStitchContext = {
  fs: Filesystem;
  manifest: VentureManifest;
  ventureRoot: string;
  shotPaths: ReadonlyArray<string>;
  ffmpegBinary?: string;
  timeoutMs?: number;
  spawn?: StitchSpawnFn;
  runId?: string;
};

export type CreateStitchResult = {
  status: "done" | "skipped";
  reelPath: string | null;
  shotCount: number;
  reason?: string;
};

const DEFAULT_TIMEOUT_MS = 180_000;

async function defaultSpawn(
  binary: string,
  args: ReadonlyArray<string>,
  opts: { cwd?: string; timeoutMs?: number },
): Promise<StitchSpawnResult> {
  const childProcess = await import(/* @vite-ignore */ "node:child_process");
  return new Promise<StitchSpawnResult>((resolve, reject) => {
    const child = childProcess.spawn(binary, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts.cwd,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // already dead
      }
      reject(new Error(`ffmpeg: timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`ffmpeg spawn failed: ${err.message}`));
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin?.end();
  });
}

function renderConcatList(shotPaths: ReadonlyArray<string>): string {
  // ffmpeg concat-demuxer requires single-quoted paths. Internal
  // single quotes escape as '\''. Most shot paths are produced by
  // workspace-core's join() so they contain no quotes, but escape
  // anyway for safety.
  const lines = shotPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'\n`);
  return lines.join("");
}

export async function createStitchStep(
  ctx: CreateStitchContext,
): Promise<CreateStitchResult> {
  const reelPath = getLaunchReelPath(ctx.ventureRoot);
  const exportsDir = getMediaExportsDir(ctx.ventureRoot);
  await ctx.fs.mkdir(exportsDir);

  if (ctx.shotPaths.length === 0) {
    return {
      status: "skipped",
      reelPath: null,
      shotCount: 0,
      reason: "no shots to stitch",
    };
  }

  // Write the concat-demuxer input list to disk so ffmpeg can read it.
  const listPath = `${exportsDir}/concat-list.txt`;
  await ctx.fs.writeFile(listPath, renderConcatList(ctx.shotPaths));

  const spawnFn = ctx.spawn ?? defaultSpawn;
  const binary = ctx.ffmpegBinary ?? "ffmpeg";
  const args: string[] = [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c",
    "copy",
    reelPath,
  ];

  const result = await spawnFn(binary, args, {
    cwd: ctx.ventureRoot,
    timeoutMs: ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    throw new Error(
      `ffmpeg concat exit ${result.code} -- ${result.stderr.slice(-240).trim()}`,
    );
  }

  return {
    status: "done",
    reelPath,
    shotCount: ctx.shotPaths.length,
  };
}
