import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { createLogger } from "@founder-os/logger";
import { ventureArtifactDirs } from "@founder-os/workspace-core";
import type { ArtifactRef } from "@founder-os/domain";
import { computeArtifactId, type ArtifactType } from "@founder-os/artifacts-core";

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

/** Infer artifact type from file extension + directory path */
export function inferArtifactType(file: ScannedFile): ArtifactType {
  const p = file.relativePath.toLowerCase();
  if (p.includes("brand-kit") || (p.includes("brand") && file.ext === ".json")) return "brand-brief";
  if (p.includes("logo") && file.ext === ".svg") return "logo-pack";
  if (p.includes("brand-kit")) return "brand-kit";
  if (p.includes("spec") && file.ext === ".md") return "product-spec";
  if (p.includes("wireframe")) return "wireframe-pack";
  if (p.includes("stitch")) return "stitch-export";
  if (p.includes("handoff") && file.ext === ".json") return "build-handoff";
  if (p.includes("audit")) return "audit-report";
  if (p.includes("market") || p.includes("research")) return "research-summary";
  if (p.includes("validation") || p.includes("validated")) return "research-summary";
  if (p.includes("uk") || p.includes("setup") || p.includes("incorporation")) return "uk-setup-checklist";
  if (p.includes("budget") || p.includes("finance")) return "budget-model";
  if (p.includes("names") || p.includes("naming")) return "naming-scan";
  if (p.includes("trademark")) return "trademark-scan";
  if (p.includes("domain")) return "domain-scan";
  if (p.includes("social")) return "social-scan";
  if (p.includes("brief")) return "dev-brief";
  return "research-summary";
}

/** Scan all artifact dirs for a venture and return ArtifactRefs */
export function scanVentureArtifacts(
  ventureId: string,
  ventureRoot: string
): ArtifactRef[] {
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
