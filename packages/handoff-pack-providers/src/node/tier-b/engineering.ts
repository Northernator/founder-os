/**
 * Slice 7 -- engineering-tier Tier-B steps.
 *
 * Two docs:
 *   - architecture-diagram   -- Mermaid diagram from backend-export / handoff.
 *   - environment-setup-guide -- repo URL + setup steps from build artefacts.
 *
 * NODE-ONLY. Both pure render -- LLM would hallucinate component
 * names. Deterministic fallback emits a placeholder Mermaid block /
 * default setup template when sources are missing.
 */
import { join } from "node:path";
import {
  getBackendExportPath,
  getHandoffExportPath,
  getStagePath,
} from "@founder-os/workspace-core";
import {
  bulletList,
  isoDate,
  readJsonIfExists,
  readMarkdownFiles,
  readTextIfExists,
  todoCallout,
  truncate,
} from "../golden/helpers.js";
import type { GoldenStep, GoldenStepResult } from "./types.js";

type BackendExportLike = {
  framework?: string;
  database?: string;
  auth?: { provider?: string };
  collections?: Array<{ name?: string }>;
  endpoints?: unknown[];
  apis?: unknown[];
};

type HandoffExportLike = {
  source?: string;
  parameters?: unknown[];
};

type VentureManifestLike = {
  repoUrl?: string;
  repo?: string;
};

// ---------------------------------------------------------------------------
// architecture-diagram
// ---------------------------------------------------------------------------

export const createArchitectureDiagramStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const backend = await readJsonIfExists<BackendExportLike>(
    getBackendExportPath(ctx.ventureRoot)
  );
  if (backend) sourcesRead.push("12_backend/backend-export.json");

  const handoffExport = await readJsonIfExists<HandoffExportLike>(
    getHandoffExportPath(ctx.ventureRoot)
  );
  if (handoffExport) sourcesRead.push("06_product/stitch/handoff-export.json");

  // Build a flowchart Mermaid block: Web client -> API -> DB, with
  // optional auth + n collection nodes.
  const blockLines: string[] = ["```mermaid", "flowchart LR"];
  blockLines.push("  Client[Web Client]");
  const api = backend?.framework?.trim() || "API";
  blockLines.push(`  API[${api}]`);
  const db = backend?.database?.trim() || "Database";
  blockLines.push(`  DB[(${db})]`);
  if (backend?.auth?.provider) {
    blockLines.push(`  Auth[${backend.auth.provider}]`);
    blockLines.push("  Client --> Auth --> API");
  } else {
    blockLines.push("  Client --> API");
  }
  blockLines.push("  API --> DB");
  const collectionCount = Array.isArray(backend?.collections) ? backend!.collections!.length : 0;
  if (collectionCount > 0) {
    blockLines.push(`  DB --> Collections{{${collectionCount} collections}}`);
  }
  blockLines.push("```");

  const detDiagram = backend
    ? blockLines.join("\n")
    : "```mermaid\nflowchart LR\n  Client[Web Client] --> API[API]\n  API --> DB[(Database)]\n```\n\n" +
        todoCallout("DIAGRAM_MERMAID", "no backend-export.json -- run BACKEND stage to specialise");

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    DIAGRAM_MERMAID: truncate(detDiagram, 3000),
    CURRENT_DATE: isoDate(ctx.now()),
  };

  return mkResult("architecture-diagram", placeholders, sourcesRead, false, notes);
};

// ---------------------------------------------------------------------------
// environment-setup-guide
// ---------------------------------------------------------------------------

export const createEnvironmentSetupGuideStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const manifestRaw = await readTextIfExists(join(ctx.ventureRoot, "venture.yaml"));
  if (manifestRaw) sourcesRead.push("venture.yaml");
  const repoFromManifest =
    extractYamlField(manifestRaw, "repoUrl") ||
    extractYamlField(manifestRaw, "repo") ||
    "";

  const buildDir = getStagePath(ctx.ventureRoot, "build");
  const readme = await readTextIfExists(join(buildDir, "README.md"));
  if (readme) sourcesRead.push("07_build/README.md");

  const buildMd = await readMarkdownFiles(buildDir, { limit: 2 });
  for (const b of buildMd) sourcesRead.push(`07_build/${b.filename}`);

  // Try to extract install commands from any README; else default
  // template with TODO callouts.
  const detRepo = repoFromManifest
    ? repoFromManifest
    : todoCallout("REPO_URL", "set repoUrl in venture.yaml");

  const setupCandidates: string[] = [];
  if (readme) {
    const setupSection = extractSection(readme, /##\s*(?:Setup|Install|Quickstart|Getting started)\b[^\n]*\n/i);
    if (setupSection) {
      const cmds = extractCommands(setupSection);
      setupCandidates.push(...cmds);
    }
  }
  if (setupCandidates.length === 0) {
    setupCandidates.push("git clone <REPO_URL>", "cd <project>", "pnpm install", "pnpm dev");
  }

  const detSteps = bulletList(
    setupCandidates,
    todoCallout("STEPS", "fill setup steps in 07_build/README.md")
  );

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    REPO_URL: detRepo,
    STEPS: truncate(detSteps, 4000),
    CURRENT_DATE: isoDate(ctx.now()),
  };

  return mkResult("environment-setup-guide", placeholders, sourcesRead, false, notes);
};

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function extractYamlField(raw: string | null, field: string): string {
  if (!raw) return "";
  const re = new RegExp(`^${field}:\\s*(.+)$`, "m");
  const m = raw.match(re);
  return m ? m[1]!.trim().replace(/^["']|["']$/g, "") : "";
}

function extractSection(md: string, headingPattern: RegExp): string | null {
  const m = md.match(headingPattern);
  if (!m) return null;
  const start = (m.index ?? 0) + m[0].length;
  const rest = md.slice(start);
  const stop = rest.search(/\n#{1,3}\s/);
  return stop === -1 ? rest.trim() : rest.slice(0, stop).trim();
}

function extractCommands(section: string): string[] {
  const lines = section.split(/\r?\n/);
  const out: string[] = [];
  let inCode = false;
  for (const ln of lines) {
    if (ln.trim().startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    const trimmed = ln.trim();
    if (inCode && trimmed.length > 0 && !trimmed.startsWith("#")) {
      out.push(trimmed);
    }
    if (out.length >= 12) break;
  }
  return out;
}

function mkResult(
  docId: string,
  placeholders: Record<string, string>,
  sourcesRead: string[],
  usedLlm: boolean,
  notes: string[]
): GoldenStepResult {
  return { docId, placeholders, sourcesRead, usedLlm, notes };
}
