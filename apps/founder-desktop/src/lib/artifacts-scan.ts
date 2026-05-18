import { type ArtifactType, computeArtifactId } from "@founder-os/artifacts-core";
import { ventureArtifactDirs } from "@founder-os/workspace-core";
/**
 * Desktop-side artifact scanner.
 *
 * Walks the venture's stage dirs via the `list_dir_recursive` Tauri command
 * (the WebView has no `node:fs`, which is why we can't use the
 * `@founder-os/artifacts-index` scanner here — it imports `node:fs` at the
 * top level and would fail to load under Vite). The inference rules below
 * are intentionally a port of `artifacts-index/src/scanner.ts#inferArtifactType`
 * — keep the two in sync if you change one.
 */
import { invoke } from "@tauri-apps/api/core";

/** Return shape from the Rust `list_dir_recursive` command. */
type RustDirEntry = {
  path: string;
  isDir: boolean;
  sizeBytes: number;
  modifiedAt: string | null;
};

/** What the Artifacts UI consumes. Richer than `ArtifactRef` because the
 *  list view wants size + mtime for sorting and display. */
export type ScannedArtifact = {
  artifactId: string;
  /** Absolute path on disk — used for the preview fetch. */
  absolutePath: string;
  /** Relative to the venture root, with forward slashes. Stable across
   *  platforms so it's safe to use in artifactId. */
  relativePath: string;
  filename: string;
  ext: string;
  type: ArtifactType;
  sizeBytes: number;
  modifiedAt: string | null;
};

/** Normalize Windows backslashes to forward slashes for stable IDs / display. */
function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

/** True if `child` is contained under `parent` (separator-agnostic). */
function relativeFromRoot(root: string, child: string): string {
  const r = toForwardSlashes(root).replace(/\/+$/, "");
  const c = toForwardSlashes(child);
  if (c.startsWith(`${r}/`)) return c.slice(r.length + 1);
  return c;
}

function basename(p: string): string {
  const norm = toForwardSlashes(p);
  const i = norm.lastIndexOf("/");
  return i === -1 ? norm : norm.slice(i + 1);
}

function extname(p: string): string {
  const name = basename(p);
  const i = name.lastIndexOf(".");
  // No leading-dot extension (e.g. ".gitignore" → no ext)
  if (i <= 0) return "";
  return name.slice(i).toLowerCase();
}

/**
 * Map a file to an artifact type. Order matters — the most specific rule
 * wins. Mirrors `inferArtifactType` in artifacts-index/scanner.ts; if you
 * change the rules over there, change them here too (or extract to a shared
 * pure-TS package).
 */
export function inferArtifactType(relativePath: string, ext: string): ArtifactType {
  const p = relativePath.toLowerCase();
  if (p.includes("13_handoff_pack") || p.includes("handoff_pack")) {
    if (ext === ".pdf") return "handoff-pack-pdf";
    if (p.endsWith("inventory.md") || p.endsWith("inventory.json"))
      return "handoff-pack-inventory";
  }
  if (p.includes("12_backend") || p.includes("/backend/")) {
    if (p.endsWith("backend-export.json")) return "backend-export";
    if (p.endsWith("backend-checkpoint.json")) return "backend-checkpoint";
  }
  if (p.includes("11_crm") || p.includes("/crm/")) {
    if (p.endsWith("crm-instance.json")) return "crm-instance";
    if (p.endsWith("crm-config.json")) return "crm-config";
    if (p.includes("/campaigns/") && ext === ".json") return "crm-campaign";
    if (p.includes("/templates/") && ext === ".md") return "crm-template";
  }
  if (p.includes("10_media") || p.includes("/media/")) {
    if (p.endsWith("media-checkpoint.json")) return "media-checkpoint";
    if (p.includes("/edits/")) return "media-edit-receipt";
    if (p.includes("/exports/") && (ext === ".mp4" || p.includes("launch-reel")))
      return "launch-reel";
    if (p.includes("/scripts/")) return "media-script";
    if (p.includes("/storyboards/")) return "storyboard";
    if (p.includes("/renders/")) return "render-shot";
  }
  if (p.endsWith("launch-receipt.json")) return "launch-receipt";
  if (p.endsWith("launch-announcement.md")) return "launch-announcement";
  if (p.endsWith("handoff-export.json")) return "handoff-export";
  if (p.endsWith("validation-summary.json") || p.endsWith("validation-summary.md"))
    return "validation-summary";
  if (p.includes("finance-plan") || p.includes("finance-canvas")) return "finance-plan";
  if (p.includes("brand-kit") || (p.includes("brand") && ext === ".json")) return "brand-brief";
  if (p.includes("logo") && ext === ".svg") return "logo-pack";
  if (p.includes("brand-kit")) return "brand-kit";
  if (p.includes("spec") && ext === ".md") return "product-spec";
  if (p.includes("wireframe")) return "wireframe-pack";
  if (p.includes("stitch")) return "stitch-export";
  if (p.includes("handoff") && ext === ".json") return "build-handoff";
  if (p.includes("audit")) return "audit-report";
  if (p.includes("market") || p.includes("research")) return "research-summary";
  if (p.includes("validation") || p.includes("validated")) return "validation-summary";
  if (p.includes("uk") || p.includes("setup") || p.includes("incorporation"))
    return "uk-setup-checklist";
  if (p.includes("budget") || p.includes("finance")) return "finance-plan";
  if (p.includes("names") || p.includes("naming")) return "naming-scan";
  if (p.includes("trademark")) return "trademark-scan";
  if (p.includes("domain")) return "domain-scan";
  if (p.includes("social-posts") || p.includes("social/posts") || p.includes("/social/"))
    return "social-post";
  if (p.includes("social")) return "social-scan";
  if (p.includes("brief")) return "dev-brief";
  return "research-summary";
}

/**
 * Scan every artifact-bearing dir under `ventureRoot` and return a flat list
 * of files (no directories). Missing dirs are silently skipped — most stage
 * dirs are empty until that part of the pipeline runs, and we don't want
 * the Artifacts tab to error on a fresh venture.
 */
export async function scanVentureArtifacts(
  ventureId: string,
  ventureRoot: string
): Promise<ScannedArtifact[]> {
  const dirs = ventureArtifactDirs(ventureRoot);
  const results: ScannedArtifact[] = [];

  for (const dir of dirs) {
    let entries: RustDirEntry[];
    try {
      entries = await invoke<RustDirEntry[]>("list_dir_recursive", { path: dir });
    } catch (err) {
      console.warn(`[artifacts-scan] list_dir_recursive failed for ${dir}`, err);
      continue;
    }

    for (const entry of entries) {
      if (entry.isDir) continue;
      const relativePath = relativeFromRoot(ventureRoot, entry.path);
      const filename = basename(entry.path);
      const ext = extname(entry.path);
      const type = inferArtifactType(relativePath, ext);
      results.push({
        artifactId: computeArtifactId(ventureId, type, relativePath),
        absolutePath: entry.path,
        relativePath,
        filename,
        ext,
        type,
        sizeBytes: entry.sizeBytes,
        modifiedAt: entry.modifiedAt,
      });
    }
  }

  // Sort by mtime DESC so freshly-pipeline-produced files surface first.
  results.sort((a, b) => {
    const am = a.modifiedAt ?? "";
    const bm = b.modifiedAt ?? "";
    return bm.localeCompare(am);
  });

  return results;
}

/** Read a single artifact file as UTF-8 text (for the preview pane). */
export async function readArtifactText(absolutePath: string): Promise<string> {
  return invoke<string>("read_file", { path: absolutePath });
}
