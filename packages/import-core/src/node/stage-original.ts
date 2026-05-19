/**
 * Copy an ingested file into the workspace's _import-cache/ tree and
 * return the workspace-relative path of the cached copy. Idempotent:
 * if the target already exists (same hash + same extension) we keep it
 * and return its size.
 *
 * Path helpers in @founder-os/workspace-core embed the workspace root in
 * their output (matching the existing helper convention). So we use the
 * helper output directly as the on-disk destination, and strip the
 * workspaceRoot prefix once to derive the workspace-relative path stored
 * in SourceDocument.cachedOriginalPath.
 */

import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { getImportCacheFilePath } from "@founder-os/workspace-core";

export interface StageOriginalOpts {
  absoluteSourcePath: string;
  workspaceRoot: string;
  contentHash: string;
  fileExtension: string;
}

export interface StageOriginalResult {
  cachedRelativePath: string;
  byteSize: number;
}

export async function stageOriginal(opts: StageOriginalOpts): Promise<StageOriginalResult> {
  const absoluteDest = getImportCacheFilePath(
    opts.workspaceRoot,
    opts.contentHash,
    opts.fileExtension,
  );

  await mkdir(dirname(absoluteDest), { recursive: true });

  let byteSize: number;
  try {
    const existing = await stat(absoluteDest);
    byteSize = existing.size;
  } catch {
    await copyFile(opts.absoluteSourcePath, absoluteDest);
    const written = await stat(absoluteDest);
    byteSize = written.size;
  }

  return {
    cachedRelativePath: stripWorkspacePrefix(absoluteDest, opts.workspaceRoot),
    byteSize,
  };
}

/**
 * Derive a workspace-relative path from a rooted helper output. The
 * helpers strip the leading slash on the root, so `getVaultRoot('/ws')`
 * returns `'ws/_vault'`; for an absolute Windows root the root passes
 * through unchanged. Either way we strip the root + leading separator.
 */
function stripWorkspacePrefix(absolutePath: string, workspaceRoot: string): string {
  const normalisedRoot = workspaceRoot.replace(/^[/\\]+/, "").replace(/[/\\]+$/, "");
  const normalisedAbs = absolutePath.replace(/\\/g, "/");
  const normalisedKey = normalisedRoot.replace(/\\/g, "/");
  if (normalisedAbs.startsWith(`${normalisedKey}/`)) {
    return normalisedAbs.slice(normalisedKey.length + 1);
  }
  return normalisedAbs;
}
