import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type ArtifactType, computeArtifactId } from "@founder-os/artifacts-core";
import type { ArtifactRef } from "@founder-os/domain";
import { createLogger } from "@founder-os/logger";
import { ventureArtifactDirs } from "@founder-os/workspace-core";

const log = createLogger("artifacts-index:scanner");

export type ScannedFile = {
  absolutePath: string;
  relativePath: string;
  filename: string;
  ext: string;
  sizeBytes: number;
  sha256: string;
  modifiedAt: string;
};

export function hashFile(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function scanDir(dirPath: string, ventureRoot: string): ScannedFile[] {
  if (!fs.existsSync(dirPath)) return [];

  const results: ScannedFile[] = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const absPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...scanDir(absPath, ventureRoot));
    } else if (entry.isFile()) {
      try {
        const stat = fs.statSync(absPath);
        const sha256 = hashFile(absPath);
        results.push({
          absolutePath: absPath,
          relativePath: path.relative(ventureRoot, absPath),
          filename: entry.name,
          ext: path.extname(entry.name).toLowerCase(),
          sizeBytes: stat.size,
          sha256,
          modifiedAt: stat.mtime.toISOString(),
        });
      } catch (err) {
        log.warn(`Could not stat/hash ${absPath}: ${err}`);
      }
    }
  }
  return results;
}

/** Infer artifact type from file extension + directory path.
 *
 * Order matters. Pipeline-hardening additions: rules for backend /
 * media / crm / handoff-pack / launch / validation / finance / social
 * stop the scanner mis-tagging everything as "research-summary".
 * Mirror of inferArtifactType in apps/founder-desktop/src/lib/artifacts-scan.ts
 * -- keep both in sync.
 */
export function inferArtifactType(file: ScannedFile): ArtifactType {
  const p = file.relativePath.toLowerCase();
  if (p.includes("13_handoff_pack") || p.includes("handoff_pack")) {
    if (file.ext === ".pdf") return "handoff-pack-pdf";
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
    if (p.includes("/campaigns/") && file.ext === ".json") return "crm-campaign";
    if (p.includes("/templates/") && file.ext === ".md") return "crm-template";
  }
  if (p.includes("10_media") || p.includes("/media/")) {
    if (p.endsWith("media-checkpoint.json")) return "media-checkpoint";
    if (p.includes("/edits/")) return "media-edit-receipt";
    if (p.includes("/exports/") && (file.ext === ".mp4" || p.includes("launch-reel")))
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
  if (p.includes("brand-kit") || (p.includes("brand") && file.ext === ".json"))
    return "brand-brief";
  if (p.includes("logo") && file.ext === ".svg") return "logo-pack";
  if (p.includes("brand-kit")) return "brand-kit";
  if (p.includes("spec") && file.ext === ".md") return "product-spec";
  if (p.includes("wireframe")) return "wireframe-pack";
  if (p.includes("stitch")) return "stitch-export";
  if (p.includes("handoff") && file.ext === ".json") return "build-handoff";
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

/** Scan all artifact dirs for a venture and return ArtifactRefs */
export function scanVentureArtifacts(ventureId: string, ventureRoot: string): ArtifactRef[] {
  const dirs = ventureArtifactDirs(ventureRoot);
  const allFiles: ScannedFile[] = [];

  for (const dir of dirs) {
    allFiles.push(...scanDir(dir, ventureRoot));
  }

  log.info(`Scanned ${allFiles.length} files for venture ${ventureId}`);

  return allFiles.map((file) => {
    const artifactType = inferArtifactType(file);
    return {
      artifactId: computeArtifactId(ventureId, artifactType, file.relativePath),
      path: file.relativePath,
      type: artifactType,
    };
  });
}
