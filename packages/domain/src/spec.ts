/**
 * Product Spec canvas (pt.41) — the founder's structured product
 * specification persisted to `06_product/specs/spec-canvas.json`.
 *
 * Mirrors the UK Setup canvas pattern (pt.33): partial / WIP-friendly
 * state stored alongside the manifest, recomputed on read where
 * possible, audited via separate rules. The canvas captures the
 * decisions a founder needs to make BEFORE wireframing or building —
 * what the product is, who it's for, what it must do, and how the
 * data + API shape out.
 *
 * Why a structured canvas instead of free-form markdown:
 *   - Audit rules can target specific gaps (no personas, no entities,
 *     missing acceptance criteria) rather than parsing prose.
 *   - The wireframe/stitch/build stages can read the canvas
 *     programmatically — feature priorities drive screen ordering,
 *     entities drive form/list components, endpoints drive the API
 *     scaffold.
 *   - The existing `product-spec.md` becomes a derived view rendered
 *     from the canvas (`renderProductSpecMarkdown`) so non-app
 *     readers still get a human-friendly artifact.
 *
 * The canvas is the single source of truth for spec completeness.
 * `must-haves` gating in the UI derives from the canvas; audit rules
 * read the canvas; stage advance to WIREFRAME_READY checks the canvas.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Sub-shapes
// ---------------------------------------------------------------------------

/**
 * A target user or persona. Personas drive feature prioritisation —
 * if no feature serves any persona's primary goal, that's a spec gap.
 * Kept lightweight: a name, a one-liner, the painPoints they bring,
 * and the primary goal that hiring this product would solve.
 */
export const PersonaSchema = z.object({
  /** Stable id used for cross-references (features can target a persona). */
  id: z.string(),
  /** Human label, e.g. "Solo SaaS Founder". */
  name: z.string().default(""),
  /** One-paragraph context: role, company size, daily reality. */
  description: z.string().default(""),
  /** Concrete pain points the founder has heard from real users. */
  painPoints: z.array(z.string()).default([]),
  /** The job-to-be-done — why they'd hire this product. */
  primaryGoal: z.string().default(""),
});
export type Persona = z.infer<typeof PersonaSchema>;

/**
 * Feature priority follows the MoSCoW convention. "Must" is the MVP
 * gate; "should" is the next tier; "nice" is opportunity work that
 * can wait. The audit's "ready to advance" rule requires at least
 * one Must feature with acceptance criteria.
 */
export const FeaturePrioritySchema = z.enum(["must", "should", "nice"]);
export type FeaturePriority = z.infer<typeof FeaturePrioritySchema>;

/**
 * A discrete capability the product offers. Features are the unit
 * the wireframe stage chunks screens around — one feature usually
 * maps to one or two screens.
 */
export const FeatureSchema = z.object({
  id: z.string(),
  /** Imperative-form name, e.g. "Sign up with email". */
  name: z.string().default(""),
  /** What the feature does in user terms. */
  description: z.string().default(""),
  priority: FeaturePrioritySchema.default("must"),
  /**
   * Acceptance criteria as plain strings — each one a checkable
   * statement ("user receives a verification email within 30 seconds").
   * Drives the build-stage testing scaffold.
   */
  acceptanceCriteria: z.array(z.string()).default([]),
  /**
   * Optional persona id this feature primarily serves. Empty string
   * = serves all personas equally. Drives the audit's "every persona
   * has at least one Must feature" rule.
   */
  personaId: z.string().default(""),
});
export type Feature = z.infer<typeof FeatureSchema>;

/**
 * A field on an entity in the data model. Keeps types as free-text
 * strings so the founder can use whatever vocabulary they're
 * comfortable with (uuid / ULID / int / numeric / text / etc.) — the
 * build stage normalises into the chosen ORM's types.
 */
export const EntityFieldSchema = z.object({
  name: z.string().default(""),
  type: z.string().default(""),
  required: z.boolean().default(false),
  description: z.string().default(""),
});
export type EntityField = z.infer<typeof EntityFieldSchema>;

/**
 * An entity in the data model — a noun the system stores. Excludes
 * relationships for now; those fall out of the field types
 * ("ownerId — uuid, FK to User") in v1. Promote to a richer
 * relationship model if/when the build stage needs more.
 */
export const EntitySchema = z.object({
  id: z.string(),
  /** Singular noun, e.g. "User", "Project", "Invoice". */
  name: z.string().default(""),
  description: z.string().default(""),
  fields: z.array(EntityFieldSchema).default([]),
});
export type Entity = z.infer<typeof EntitySchema>;

/**
 * REST-ish API endpoint. The canvas is API-style-agnostic — GraphQL,
 * tRPC, RPC-over-HTTP all fit "method + path + description" with
 * minor stretching. We don't validate path syntax because the canvas
 * accepts work-in-progress strings.
 */
export const HttpMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

export const ApiEndpointSchema = z.object({
  id: z.string(),
  method: HttpMethodSchema.default("GET"),
  /** Path or operation name, e.g. "/api/projects" or "createProject". */
  path: z.string().default(""),
  description: z.string().default(""),
  /** Free-text shape hints — body, query params, expected response. */
  requestNotes: z.string().default(""),
  responseNotes: z.string().default(""),
});
export type ApiEndpoint = z.infer<typeof ApiEndpointSchema>;

/**
 * Non-functional requirement category. Driven by the manifest flags
 * downstream — handlesPersonalData implies "security" + "compliance"
 * are relevant, takesPayments adds "compliance" (PCI), regulated
 * adds whichever applies. The canvas accepts whatever the founder
 * actually cares about; the audit just nudges if no NFR is set.
 */
export const NonFunctionalCategorySchema = z.enum([
  "performance",
  "security",
  "accessibility",
  "compliance",
  "scalability",
  "reliability",
  "other",
]);
export type NonFunctionalCategory = z.infer<typeof NonFunctionalCategorySchema>;

export const NonFunctionalRequirementSchema = z.object({
  id: z.string(),
  category: NonFunctionalCategorySchema.default("performance"),
  /** What the requirement is, e.g. "p95 response time under 200ms". */
  description: z.string().default(""),
  /** Concrete target value if applicable, e.g. "200ms" or "WCAG 2.1 AA". */
  target: z.string().default(""),
});
export type NonFunctionalRequirement = z.infer<typeof NonFunctionalRequirementSchema>;

/**
 * Success metric — the founder's definition of "this is working".
 * Drives the eventual analytics scaffold but lives here so it's
 * decided BEFORE building, not after.
 */
export const MetricSchema = z.object({
  id: z.string(),
  /** Metric name, e.g. "Activation rate", "MRR", "D7 retention". */
  name: z.string().default(""),
  /** Target the founder is aiming for. */
  target: z.string().default(""),
  /**
   * Current baseline if known. For pre-launch ventures this is
   * usually empty; populated during the AUDIT_READY / LAUNCH_READY
   * stages.
   */
  currentBaseline: z.string().default(""),
});
export type Metric = z.infer<typeof MetricSchema>;

/**
 * Data model wrapper — separated so the JSON shape leaves room for
 * future additions (relationships, indexes, denormalised views) without
 * churning the top-level canvas.
 */
export const DataModelSchema = z.object({
  entities: z.array(EntitySchema).default([]),
});
export type DataModel = z.infer<typeof DataModelSchema>;

/**
 * API surface wrapper — same logic. Future additions: webhook
 * definitions, websocket events, third-party integration shapes.
 */
export const ApiSurfaceSchema = z.object({
  endpoints: z.array(ApiEndpointSchema).default([]),
});
export type ApiSurface = z.infer<typeof ApiSurfaceSchema>;

// ---------------------------------------------------------------------------
// Top-level canvas
// ---------------------------------------------------------------------------

/**
 * The on-disk canvas at `06_product/specs/spec-canvas.json`. Versioned
 * so we can evolve the schema without corrupting existing files.
 */
export const ProductSpecCanvasSchema = z.object({
  ventureId: z.string(),
  /**
   * Product purpose statement — the one-paragraph "what is this and
   * why does it matter" that grounds every downstream decision. Often
   * the most-rewritten field; keep it short.
   */
  purpose: z.string().default(""),
  personas: z.array(PersonaSchema).default([]),
  features: z.array(FeatureSchema).default([]),
  /**
   * In-scope items — concrete capabilities the v1 will ship with.
   * Distinct from features: an in-scope item might be cross-cutting
   * ("works on mobile web", "exports to CSV") rather than a single
   * named feature. Free-text strings.
   */
  inScope: z.array(z.string()).default([]),
  /**
   * Out-of-scope items — explicit "we are NOT building" statements.
   * Reduces ambiguity at hand-off and gives a place to record
   * deferred ideas without losing them.
   */
  outOfScope: z.array(z.string()).default([]),
  dataModel: DataModelSchema.default(() => DataModelSchema.parse({})),
  apiSurface: ApiSurfaceSchema.default(() => ApiSurfaceSchema.parse({})),
  nonFunctional: z.array(NonFunctionalRequirementSchema).default([]),
  metrics: z.array(MetricSchema).default([]),
  /** Free-text notes for anything that doesn't fit the structured fields. */
  notes: z.string().default(""),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().default(1),
});
export type ProductSpecCanvas = z.infer<typeof ProductSpecCanvasSchema>;

/**
 * Build a fresh canvas. Called by the pipeline step when no existing
 * canvas is present. Everything starts blank — the founder fills it
 * via the SpecTab.
 */
export function createEmptyProductSpecCanvas(ventureId: string): ProductSpecCanvas {
  const now = new Date().toISOString();
  return ProductSpecCanvasSchema.parse({
    ventureId,
    createdAt: now,
    updatedAt: now,
  });
}

// ---------------------------------------------------------------------------
// Must-haves derivation
// ---------------------------------------------------------------------------

/**
 * Whether the spec is "complete enough" to advance to WIREFRAME_READY.
 * Each rule returns whether it passes; the UI panel surfaces unmet
 * rules as the must-haves checklist; the audit emits findings for any
 * unmet rule.
 *
 * Rules in declaration order so UI + audit stay in sync.
 */
export type ProductSpecRule = {
  id: string;
  label: string;
  description: string;
  pass: boolean;
};

/**
 * Compute must-haves from the canvas. The rules don't need manifest
 * flags currently — the spec stage's gates are universal across app
 * types. If we later want appType-specific gates (a saas spec needs
 * billing endpoints, a game spec needs a feedback loop spec, etc.)
 * extend the signature with `flags`.
 */
export function deriveProductSpecRules(canvas: ProductSpecCanvas): ProductSpecRule[] {
  const rules: ProductSpecRule[] = [];

  rules.push({
    id: "purpose.set",
    label: "Purpose statement set",
    description: "One-paragraph 'what & why' grounding the spec",
    pass: canvas.purpose.trim().length >= 20,
  });

  rules.push({
    id: "personas.at-least-one",
    label: "At least one persona",
    description: "Who this is being built for",
    pass: canvas.personas.some((p) => p.name.trim().length > 0),
  });

  rules.push({
    id: "features.at-least-one-must",
    label: "At least one Must-have feature",
    description: "MVP scope is defined by Must-priority features",
    pass: canvas.features.some((f) => f.priority === "must" && f.name.trim().length > 0),
  });

  rules.push({
    id: "features.acceptance-criteria",
    label: "Must features have acceptance criteria",
    description: "Each Must feature lists at least one checkable AC",
    pass:
      canvas.features
        .filter((f) => f.priority === "must" && f.name.trim().length > 0)
        .every((f) => f.acceptanceCriteria.length > 0) &&
      canvas.features.some((f) => f.priority === "must" && f.name.trim().length > 0),
  });

  rules.push({
    id: "scope.boundary-set",
    label: "Scope boundary set",
    description: "At least one in-scope OR out-of-scope item",
    pass:
      canvas.inScope.some((s) => s.trim().length > 0) ||
      canvas.outOfScope.some((s) => s.trim().length > 0),
  });

  rules.push({
    id: "data-model.at-least-one-entity",
    label: "Data model has at least one entity",
    description: "Even an MVP needs to model what it stores",
    pass: canvas.dataModel.entities.some((e) => e.name.trim().length > 0),
  });

  rules.push({
    id: "api.at-least-one-endpoint",
    label: "API surface has at least one endpoint",
    description: "Even a static-rendered app has at least one auth/me",
    pass: canvas.apiSurface.endpoints.some((e) => e.path.trim().length > 0),
  });

  rules.push({
    id: "nfr.at-least-one",
    label: "At least one non-functional requirement",
    description: "Performance, security, accessibility — one gate",
    pass: canvas.nonFunctional.some((n) => n.description.trim().length > 0),
  });

  rules.push({
    id: "metrics.at-least-one",
    label: "At least one success metric",
    description: "How will you know v1 is working?",
    pass: canvas.metrics.some((m) => m.name.trim().length > 0 && m.target.trim().length > 0),
  });

  return rules;
}

/**
 * Convenience — true when every applicable rule passes. The UI uses
 * this to gate the "ready to advance to Wireframe" badge.
 */
export function isProductSpecComplete(canvas: ProductSpecCanvas): boolean {
  return deriveProductSpecRules(canvas).every((r) => r.pass);
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

/**
 * Render the canvas as a human-friendly markdown document. The
 * pipeline step writes this to `06_product/specs/product-spec.md` on
 * every run so non-app readers (collaborators, future-you outside the
 * app, exports) can see the spec without parsing JSON.
 *
 * Pure data → string; no IO. The lib lives in `domain` so any package
 * can call it (CLI tools, tests, etc.) without pulling in node:fs.
 */
export function renderProductSpecMarkdown(
  canvas: ProductSpecCanvas,
  opts?: { ventureName?: string }
): string {
  const { ventureName = "" } = opts ?? {};
  const lines: string[] = [];

  lines.push(`# Product Spec${ventureName ? ` — ${ventureName}` : ""}`, "");

  if (canvas.purpose.trim()) {
    lines.push("## Purpose", "", canvas.purpose.trim(), "");
  }

  if (canvas.personas.length > 0) {
    lines.push("## Target Users", "");
    for (const p of canvas.personas) {
      if (!p.name.trim()) continue;
      lines.push(`### ${p.name}`, "");
      if (p.description.trim()) lines.push(p.description.trim(), "");
      if (p.primaryGoal.trim()) {
        lines.push(`**Primary goal:** ${p.primaryGoal.trim()}`, "");
      }
      if (p.painPoints.length > 0) {
        lines.push("**Pain points:**");
        for (const pp of p.painPoints) {
          if (pp.trim()) lines.push(`- ${pp.trim()}`);
        }
        lines.push("");
      }
    }
  }

  if (canvas.features.length > 0) {
    lines.push("## Features", "");
    const byPriority: Record<FeaturePriority, Feature[]> = {
      must: [],
      should: [],
      nice: [],
    };
    for (const f of canvas.features) {
      if (f.name.trim()) byPriority[f.priority].push(f);
    }
    const priorityLabels: Record<FeaturePriority, string> = {
      must: "Must-have (MVP)",
      should: "Should-have",
      nice: "Nice-to-have",
    };
    for (const tier of ["must", "should", "nice"] as FeaturePriority[]) {
      if (byPriority[tier].length === 0) continue;
      lines.push(`### ${priorityLabels[tier]}`, "");
      for (const f of byPriority[tier]) {
        lines.push(`#### ${f.name}`);
        if (f.description.trim()) lines.push("", f.description.trim());
        if (f.acceptanceCriteria.length > 0) {
          lines.push("", "Acceptance criteria:");
          for (const ac of f.acceptanceCriteria) {
            if (ac.trim()) lines.push(`- [ ] ${ac.trim()}`);
          }
        }
        lines.push("");
      }
    }
  }

  if (canvas.inScope.length > 0 || canvas.outOfScope.length > 0) {
    lines.push("## Scope", "");
    if (canvas.inScope.length > 0) {
      lines.push("### In scope", "");
      for (const s of canvas.inScope) {
        if (s.trim()) lines.push(`- ${s.trim()}`);
      }
      lines.push("");
    }
    if (canvas.outOfScope.length > 0) {
      lines.push("### Out of scope", "");
      for (const s of canvas.outOfScope) {
        if (s.trim()) lines.push(`- ${s.trim()}`);
      }
      lines.push("");
    }
  }

  if (canvas.dataModel.entities.length > 0) {
    lines.push("## Data Model", "");
    for (const e of canvas.dataModel.entities) {
      if (!e.name.trim()) continue;
      lines.push(`### ${e.name}`);
      if (e.description.trim()) lines.push("", e.description.trim());
      if (e.fields.length > 0) {
        lines.push(
          "",
          "| Field | Type | Required | Description |",
          "|-------|------|----------|-------------|"
        );
        for (const f of e.fields) {
          if (!f.name.trim()) continue;
          lines.push(
            `| ${f.name.trim()} | ${f.type.trim() || "?"} | ${
              f.required ? "yes" : "no"
            } | ${f.description.trim().replace(/\|/g, "\\|") || ""} |`
          );
        }
      }
      lines.push("");
    }
  }

  if (canvas.apiSurface.endpoints.length > 0) {
    lines.push("## API Surface", "");
    lines.push("| Method | Path | Description |", "|--------|------|-------------|");
    for (const ep of canvas.apiSurface.endpoints) {
      if (!ep.path.trim()) continue;
      lines.push(
        `| ${ep.method} | \`${ep.path.trim()}\` | ${ep.description.trim().replace(/\|/g, "\\|") || ""} |`
      );
    }
    lines.push("");
    // Per-endpoint detail blocks for endpoints with notes — keeps the
    // table compact but doesn't lose the request/response notes.
    for (const ep of canvas.apiSurface.endpoints) {
      if (!ep.path.trim()) continue;
      const hasNotes = ep.requestNotes.trim().length > 0 || ep.responseNotes.trim().length > 0;
      if (!hasNotes) continue;
      lines.push(`### ${ep.method} ${ep.path.trim()}`, "");
      if (ep.requestNotes.trim()) {
        lines.push("**Request:**", "", ep.requestNotes.trim(), "");
      }
      if (ep.responseNotes.trim()) {
        lines.push("**Response:**", "", ep.responseNotes.trim(), "");
      }
    }
  }

  if (canvas.nonFunctional.length > 0) {
    lines.push("## Non-functional Requirements", "");
    lines.push("| Category | Requirement | Target |", "|----------|-------------|--------|");
    for (const n of canvas.nonFunctional) {
      if (!n.description.trim()) continue;
      lines.push(
        `| ${n.category} | ${n.description.trim().replace(/\|/g, "\\|")} | ${n.target.trim().replace(/\|/g, "\\|") || "—"} |`
      );
    }
    lines.push("");
  }

  if (canvas.metrics.length > 0) {
    lines.push("## Success Metrics", "");
    lines.push("| Metric | Target | Baseline |", "|--------|--------|----------|");
    for (const m of canvas.metrics) {
      if (!m.name.trim()) continue;
      lines.push(
        `| ${m.name.trim()} | ${m.target.trim() || "—"} | ${m.currentBaseline.trim() || "—"} |`
      );
    }
    lines.push("");
  }

  if (canvas.notes.trim()) {
    lines.push("## Notes", "", canvas.notes.trim(), "");
  }

  lines.push("---", `_Rendered from spec-canvas.json on ${new Date().toISOString()}_`, "");

  return lines.join("\n");
}
