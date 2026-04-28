/**
 * Disk-side venture operations: folder picking, scaffolding the stage
 * directory tree, and writing the venture.yaml manifest.
 *
 * All path manipulation goes through Rust commands (see src-tauri/src/lib.rs)
 * rather than @tauri-apps/plugin-fs, because the user picks an arbitrary
 * folder outside any preconfigured fs scope.
 */
import { invoke } from "@tauri-apps/api/core";
import { VENTURE_DIR_SKELETON } from "@founder-os/workspace-core";
import { VentureManifestSchema, type VentureManifest } from "@founder-os/domain";
import { pushToast } from "./toasts.js";

/** Short human string for toast details — stringify unknown errors cleanly. */
function errDetail(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Open the native folder picker. Returns null if the user cancelled. */
export async function pickVentureFolder(): Promise<string | null> {
  const folder = await invoke<string | null>("pick_venture_folder");
  return folder ?? null;
}

/** True if the string looks like a Windows path (drive letter or backslash). */
function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.includes("\\");
}

/** Join a parent path + a child segment using the right separator for the OS. */
export function joinPath(parent: string, child: string): string {
  const sep = isWindowsPath(parent) ? "\\" : "/";
  const trimmed = parent.replace(/[\\/]+$/, "");
  return `${trimmed}${sep}${child}`;
}

/** Create all the numbered stage folders + .founder runtime dirs under root. */
export async function scaffoldVentureDirs(rootPath: string): Promise<void> {
  await invoke("create_venture_dirs", {
    rootPath,
    dirs: VENTURE_DIR_SKELETON,
  });
}

/**
 * Write the venture.yaml manifest at the venture root.
 *
 * Uses JSON-as-YAML: JSON is a valid subset of YAML 1.2, so any YAML
 * parser (including js-yaml, serde_yaml) will read this correctly. This
 * avoids pulling in a YAML serializer for a flat schema.
 */
export async function writeVentureManifest(
  rootPath: string,
  manifest: VentureManifest
): Promise<void> {
  const manifestPath = joinPath(rootPath, "venture.yaml");
  await invoke("write_file", {
    path: manifestPath,
    content: JSON.stringify(manifest, null, 2) + "\n",
  });
}

/** Convenience: scaffold dirs and write manifest in one call. */
export async function provisionVentureWorkspace(
  rootPath: string,
  manifest: VentureManifest
): Promise<void> {
  await scaffoldVentureDirs(rootPath);
  await writeVentureManifest(rootPath, manifest);
}

/**
 * Reveal a folder in the OS file manager (Explorer / Finder / xdg-open).
 * Throws if the path doesn't exist on disk.
 */
export async function openInFileManager(path: string): Promise<void> {
  await invoke("open_path", { path });
}

/**
 * Delete a venture's folder on disk. No-op if the folder is already gone.
 * Caller is responsible for also removing the DB row + clearing it from
 * the in-memory store.
 */
export async function deleteVentureDir(rootPath: string): Promise<void> {
  await invoke("delete_dir", { path: rootPath });
}

/**
 * Read the venture.yaml manifest written at create-time. We store JSON
 * inside the .yaml file (JSON is valid YAML 1.2), so JSON.parse works.
 * Returns null if the file is missing, unreadable, or fails validation —
 * callers can then fall back to building a minimal manifest from the
 * Venture row.
 *
 * Three failure modes, distinguished on purpose:
 *  - **Read throws** (file missing / permission / IO): silent. A legacy
 *    venture created before we wrote venture.yaml is a normal case, not
 *    something to pester the user about. Console.warn only.
 *  - **JSON.parse throws**: the file exists but isn't valid JSON/YAML.
 *    That's genuinely corrupt — warn toast so the founder can go fix it
 *    instead of wondering why their custom settings silently revert to
 *    defaults.
 *  - **Schema validation fails**: file parsed, but the shape is wrong
 *    (e.g. an old appType value, missing required field, bad enum). Also
 *    warn toast, with the zod issue path so it's actionable.
 */
export async function loadVentureManifest(
  rootPath: string
): Promise<VentureManifest | null> {
  let raw: string;
  try {
    raw = await invoke<string>("read_file", {
      path: joinPath(rootPath, "venture.yaml"),
    });
  } catch (err) {
    // Missing or unreadable — treat as legacy, no manifest. Stay silent.
    console.warn("[fs] loadVentureManifest: read_file failed", err);
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    console.warn("[fs] loadVentureManifest: JSON.parse failed", err);
    pushToast({
      kind: "warn",
      message: "Corrupt venture.yaml — using fallback manifest",
      detail: errDetail(err),
    });
    return null;
  }

  const result = VentureManifestSchema.safeParse(parsedJson);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? issue.path.join(".") : "?";
    const what = issue?.message ?? "unknown validation error";
    console.warn(
      "[fs] loadVentureManifest: schema validation failed",
      result.error
    );
    pushToast({
      kind: "warn",
      message: "venture.yaml doesn't match expected shape — using fallback",
      detail: `${where}: ${what}`,
    });
    return null;
  }

  return result.data;
}
