/**
 * Turns an absolute path into a DiscoveredFile. The OS does not give us
 * a mime type from a path alone -- the renderer-side dialog plugin
 * sometimes does, but here we leave mimeType undefined and let
 * detectFileType fall back to extension + magic bytes.
 */

import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { DiscoveredFile } from "../walk";

export async function resolveFile(absolutePath: string): Promise<DiscoveredFile> {
  const s = await stat(absolutePath);
  if (!s.isFile()) {
    throw new Error(`resolveFile: not a regular file -- ${absolutePath}`);
  }
  return { absolutePath, originalName: basename(absolutePath) };
}
