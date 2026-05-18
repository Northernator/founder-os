/**
 * Slice 6 -- engineering-tier Golden steps.
 *
 * Four docs:
 *   - developer-brief         -- product overview + stack + constraints.
 *   - technical-specification -- architecture + stack across handoff/backend/build.
 *   - database-schema         -- collections/tables from backend-export.
 *   - api-specification       -- endpoints + auth rules from backend-export.
 *
 * NODE-ONLY. Reads:
 *   06_product/specs/spec-canvas.json
 *   06_product/stitch/handoff-export.json
 *   12_backend/backend-export.json
 */
import { join } from "node:path";
import {
  getBackendExportPath,
  getHandoffExportPath,
  getSpecCanvasPath,
  getStagePath,
} from "@founder-os/workspace-core";
import {
  bulletList,
  callLlmStrict,
  isoDate,
  readJsonIfExists,
  readMarkdownFiles,
  todoCallout,
  truncate,
} from "./helpers.js";
import type { GoldenStep, GoldenStepResult } from "./types.js";

// ---------------------------------------------------------------------------
// Shape stubs (best-effort)
// ---------------------------------------------------------------------------

type SpecCanvasLike = {
  productName?: string;
  mission?: string;
  features?: Array<{ name?: string; description?: string; priority?: string }>;
  constraints?: string[];
  stack?: string[] | Record<string, string>;
};

type HandoffExportLike = {
  source?: string;
  parameters?: Array<{ key?: string; value?: unknown; label?: string }>;
  tokens?: Record<string, unknown>;
};

type BackendExportLike = {
  framework?: string;
  database?: string;
  auth?: { provider?: string; strategy?: string; mfa?: boolean };
  collections?: Array<{
    name?: string;
    fields?: Array<{ name?: string; type?: string; required?: boolean; indexed?: boolean }>;
    indexes?: string[];
    relationships?: Array<{ from?: string; to?: string; kind?: string }>;
  }>;
  apis?: Array<{
    method?: string;
    path?: string;
    description?: string;
    auth?: string;
    requestSchema?: unknown;
    responseSchema?: unknown;
  }>;
  endpoints?: Array<{
    method?: string;
    path?: string;
    description?: string;
    auth?: string;
  }>;
};

async function loadSpecCanvas(ventureRoot: string): Promise<SpecCanvasLike | null> {
  return readJsonIfExists<SpecCanvasLike>(getSpecCanvasPath(ventureRoot));
}

async function loadHandoffExport(ventureRoot: string): Promise<HandoffExportLike | null> {
  return readJsonIfExists<HandoffExportLike>(getHandoffExportPath(ventureRoot));
}

async function loadBackendExport(ventureRoot: string): Promise<BackendExportLike | null> {
  return readJsonIfExists<BackendExportLike>(getBackendExportPath(ventureRoot));
}

function renderStack(canvas: SpecCanvasLike | null, backend: BackendExportLike | null): string[] {
  const out: string[] = [];
  const stack = canvas?.stack;
  if (Array.isArray(stack)) {
    out.push(...stack.map((s) => s.toString().trim()).filter((s) => s.length > 0));
  } else if (stack && typeof stack === "object") {
    for (const [k, v] of Object.entries(stack)) out.push(`${k}: ${v}`);
  }
  if (backend?.framework) out.push(`Backend: ${backend.framework}`);
  if (backend?.database) out.push(`Database: ${backend.database}`);
  if (backend?.auth?.provider) out.push(`Auth: ${backend.auth.provider}`);
  return out;
}

// ---------------------------------------------------------------------------
// developer-brief
// ---------------------------------------------------------------------------

export const createDeveloperBriefStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const canvas = await loadSpecCanvas(ctx.ventureRoot);
  if (canvas) sourcesRead.push("06_product/specs/spec-canvas.json");

  const handoffExport = await loadHandoffExport(ctx.ventureRoot);
  if (handoffExport) sourcesRead.push("06_product/stitch/handoff-export.json");

  const backend = await loadBackendExport(ctx.ventureRoot);
  if (backend) sourcesRead.push("12_backend/backend-export.json");

  const productName = canvas?.productName?.trim() || ctx.ventureName;
  const stackLines = renderStack(canvas, backend);
  const constraints = Array.isArray(canvas?.constraints) ? canvas!.constraints! : [];

  const detStack = bulletList(stackLines, todoCallout("STACK", "no stack captured in spec-canvas or backend-export"));
  const detConstraints = bulletList(
    constraints,
    todoCallout("CONSTRAINTS", "capture non-functional constraints in spec canvas (perf/uptime/data-residency)")
  );

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    PRODUCT_NAME: productName,
    CURRENT_DATE: isoDate(ctx.now()),
    STACK: detStack,
    CONSTRAINTS: detConstraints,
  };

  let usedLlm = false;
  if (ctx.callLlm && (stackLines.length > 0 || constraints.length > 0)) {
    try {
      const synth = await callLlmStrict(ctx.callLlm, {
        system: `You are writing the CONSTRAINTS section of a developer brief for "${productName}". Output a markdown bullet list capturing non-functional requirements (perf, uptime, data residency, security, accessibility, browser support, mobile). ~150-300 words.`,
        user: `Spec canvas constraints: ${JSON.stringify(constraints)}\nBackend: ${JSON.stringify({ framework: backend?.framework, db: backend?.database, auth: backend?.auth }, null, 2)}\nStack: ${stackLines.join(", ")}`,
      });
      placeholders.CONSTRAINTS = synth;
      usedLlm = true;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notes.push(`developer-brief: LLM failed -- using deterministic: ${m}`);
    }
  }

  return { docId: "developer-brief", placeholders, sourcesRead, usedLlm, notes };
};

// ---------------------------------------------------------------------------
// technical-specification
// ---------------------------------------------------------------------------

export const createTechnicalSpecificationStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const handoffExport = await loadHandoffExport(ctx.ventureRoot);
  if (handoffExport) sourcesRead.push("06_product/stitch/handoff-export.json");

  const backend = await loadBackendExport(ctx.ventureRoot);
  if (backend) sourcesRead.push("12_backend/backend-export.json");

  const buildDir = getStagePath(ctx.ventureRoot, "build");
  const buildArtefacts = await readMarkdownFiles(buildDir, { limit: 3 });
  for (const b of buildArtefacts) sourcesRead.push(`07_build/${b.filename}`);

  const stackLines = renderStack(null, backend);
  const detStack = bulletList(stackLines, todoCallout("STACK", "run BACKEND stage to populate stack"));

  const archLines: string[] = [];
  if (backend?.framework) archLines.push(`- API layer: ${backend.framework}`);
  if (backend?.database) archLines.push(`- Persistence: ${backend.database}`);
  if (backend?.auth?.strategy) archLines.push(`- Auth strategy: ${backend.auth.strategy}`);
  if (handoffExport?.source) archLines.push(`- Frontend handoff source: ${handoffExport.source}`);
  const collections = Array.isArray(backend?.collections) ? backend!.collections! : [];
  if (collections.length > 0) {
    archLines.push(`- ${collections.length} domain collections; see Database Schema doc`);
  }
  const endpoints = Array.isArray(backend?.apis) ? backend!.apis! : Array.isArray(backend?.endpoints) ? backend!.endpoints! : [];
  if (endpoints.length > 0) {
    archLines.push(`- ${endpoints.length} REST endpoints; see API Specification doc`);
  }
  const detArchitecture = archLines.length > 0
    ? archLines.join("\n")
    : todoCallout("ARCHITECTURE", "no backend-export.json -- architecture not derivable yet");

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    CURRENT_DATE: isoDate(ctx.now()),
    ARCHITECTURE: detArchitecture,
    STACK: detStack,
  };

  let usedLlm = false;
  if (ctx.callLlm && backend) {
    try {
      const synth = await callLlmStrict(ctx.callLlm, {
        system: `You are writing the ARCHITECTURE section of a technical specification for "${ctx.ventureName}". Output 2-3 paragraphs of plain prose describing the system shape (frontend/backend boundary, persistence, auth, key services, integrations). ~250-450 words.`,
        user: `Backend export summary:\n${JSON.stringify({
          framework: backend.framework,
          database: backend.database,
          auth: backend.auth,
          collectionCount: collections.length,
          endpointCount: endpoints.length,
        }, null, 2)}\nHandoff source: ${handoffExport?.source ?? "(none)"}`,
      });
      placeholders.ARCHITECTURE = synth;
      usedLlm = true;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notes.push(`technical-specification: LLM failed -- using deterministic: ${m}`);
    }
  }

  return { docId: "technical-specification", placeholders, sourcesRead, usedLlm, notes };
};

// ---------------------------------------------------------------------------
// database-schema
// ---------------------------------------------------------------------------

export const createDatabaseSchemaStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const backend = await loadBackendExport(ctx.ventureRoot);
  if (backend) sourcesRead.push("12_backend/backend-export.json");

  const collections = Array.isArray(backend?.collections) ? backend!.collections! : [];

  let detCollections: string;
  if (collections.length === 0) {
    detCollections = todoCallout("COLLECTIONS", "no backend-export.json -- run BACKEND stage first");
  } else {
    const blocks: string[] = [];
    for (const c of collections.slice(0, 40)) {
      const name = c.name?.trim() || "(unnamed)";
      blocks.push(`### \`${name}\``);
      const fields = Array.isArray(c.fields) ? c.fields : [];
      if (fields.length > 0) {
        blocks.push("");
        blocks.push("| Field | Type | Required | Indexed |");
        blocks.push("|---|---|---|---|");
        for (const f of fields.slice(0, 30)) {
          const fname = f.name?.trim() || "?";
          const ftype = f.type?.trim() || "?";
          const req = f.required ? "yes" : "no";
          const idx = f.indexed ? "yes" : "no";
          blocks.push(`| \`${fname}\` | ${ftype} | ${req} | ${idx} |`);
        }
      }
      if (Array.isArray(c.indexes) && c.indexes.length > 0) {
        blocks.push("");
        blocks.push(`_Indexes:_ ${c.indexes.join(", ")}`);
      }
      if (Array.isArray(c.relationships) && c.relationships.length > 0) {
        blocks.push("");
        blocks.push(`_Relationships:_ ${c.relationships.map((r) => `${r.from ?? "?"} -> ${r.to ?? "?"} (${r.kind ?? "?"})`).join("; ")}`);
      }
      blocks.push("");
    }
    detCollections = blocks.join("\n");
  }

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    CURRENT_DATE: isoDate(ctx.now()),
    COLLECTIONS: truncate(detCollections, 8000),
  };

  // No LLM here -- the schema is a faithful render of backend-export.json.
  // An LLM pass would invent fields and hallucinate types.
  return { docId: "database-schema", placeholders, sourcesRead, usedLlm: false, notes };
};

// ---------------------------------------------------------------------------
// api-specification
// ---------------------------------------------------------------------------

export const createApiSpecificationStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const backend = await loadBackendExport(ctx.ventureRoot);
  if (backend) sourcesRead.push("12_backend/backend-export.json");

  const endpoints = Array.isArray(backend?.apis)
    ? backend!.apis!
    : Array.isArray(backend?.endpoints)
      ? backend!.endpoints!
      : [];

  let detEndpoints: string;
  if (endpoints.length === 0) {
    detEndpoints = todoCallout("ENDPOINTS", "no APIs in backend-export.json -- run BACKEND stage");
  } else {
    const lines: string[] = [];
    lines.push("| Method | Path | Auth | Description |");
    lines.push("|---|---|---|---|");
    for (const e of endpoints.slice(0, 60)) {
      const method = (e.method ?? "GET").toUpperCase();
      const path = e.path ?? "/";
      const auth = e.auth ?? "(default)";
      const desc = (e.description ?? "").replace(/\|/g, "\\|");
      lines.push(`| ${method} | \`${path}\` | ${auth} | ${desc} |`);
    }
    detEndpoints = lines.join("\n");
  }

  const authProvider = backend?.auth?.provider ?? "";
  const authStrategy = backend?.auth?.strategy ?? "";
  const detAuth = authProvider || authStrategy
    ? [
        authProvider ? `- **Provider:** ${authProvider}` : "",
        authStrategy ? `- **Strategy:** ${authStrategy}` : "",
        backend?.auth?.mfa ? "- **MFA:** required" : "",
      ].filter((l) => l.length > 0).join("\n")
    : todoCallout("AUTH", "no auth block in backend-export -- specify auth provider + strategy");

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    CURRENT_DATE: isoDate(ctx.now()),
    ENDPOINTS: truncate(detEndpoints, 8000),
    AUTH: detAuth,
  };

  return { docId: "api-specification", placeholders, sourcesRead, usedLlm: false, notes };
};

export type { GoldenStepResult };
