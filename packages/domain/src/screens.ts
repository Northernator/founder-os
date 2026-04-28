/**
 * Screens canvas (pt.43) — the founder's product screen inventory
 * persisted to `06_product/wireframes/screens-canvas.json`.
 *
 * Mirrors the UK Setup canvas (pt.33) and Spec canvas (pt.41) patterns:
 * partial / WIP-friendly state stored alongside the manifest, derived
 * must-haves shared with the audit, markdown view rendered on every
 * pipeline run.
 *
 * Naming note: the stage enum value is `WIREFRAME_READY` (pre-pt.41
 * legacy) and the on-disk folder is `06_product/wireframes/`, but
 * the canvas + UI are deliberately scoped narrower than full
 * wireframes. Per the pt.43 deliberately-did-not policy:
 *   - We capture a screen INVENTORY (name + shell type + feature
 *     mapping + entity mapping + notes), NOT element-level layout
 *     bounds, regions, or SVG.
 *   - Visual generation lives DOWNSTREAM in Stitch / v0 / Figma Make
 *     (driven by `create-stitch-pack`'s richer config from pt.44).
 *   - "Screens" is the user-facing label everywhere — tab, canvas
 *     filename, audit ruleId prefix. The stage enum stays
 *     `WIREFRAME_READY` to avoid a 13-file rename + DB migration.
 *
 * The shell-type taxonomy is lifted from a separate
 * wireframe-orchestrator-starter project's wireframe-recipes.ts
 * (DASHBOARD / LIST_DETAIL / FORM / EDITOR / SETTINGS / DETAIL /
 * LANDING / WIZARD / SEARCH). We add AUTH and OTHER to round out
 * the catalogue. We lift ONLY the enum + one-line descriptions —
 * none of the bounding-box / region / element generation.
 *
 * Why a structured canvas instead of free-form markdown:
 *   - The audit can flag specific gaps (no screens, missing shell
 *     type, Must features without coverage) rather than parsing prose.
 *   - The stitch pack step (pt.44) reads the canvas to give Stitch
 *     per-screen direction, not just a hardcoded ["onboarding",
 *     "dashboard", "settings"] list.
 *   - The wireframes.md is a derived view rendered on every pipeline
 *     run, so non-app readers still get a human-friendly artifact.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shell-type catalogue
// ---------------------------------------------------------------------------

/**
 * Shell type — the broad layout shape a screen takes. Drives the
 * dropdown on each ScreenCard in the UI and feeds the stitch pack
 * step (pt.44) so Stitch / v0 / Figma Make get layout direction
 * rather than inferring from feature names alone.
 *
 * Catalog matches the wireframe-recipes.ts taxonomy from the
 * wireframe-orchestrator-starter reference project, plus AUTH and
 * OTHER added here. Values are SCREAMING_SNAKE so they read
 * stably in the canvas JSON without locale-aware case issues.
 */
export const ShellTypeSchema = z.enum([
  "DASHBOARD",
  "LIST_DETAIL",
  "FORM",
  "EDITOR",
  "SETTINGS",
  "DETAIL",
  "LANDING",
  "WIZARD",
  "SEARCH",
  "AUTH",
  "OTHER",
]);
export type ShellType = z.infer<typeof ShellTypeSchema>;

/**
 * UI-friendly labels for the shell type dropdown. Keep separate from
 * the enum so we can rename the display without churning the
 * persisted canvas data.
 */
export const SHELL_TYPE_LABELS: Record<ShellType, string> = {
  DASHBOARD: "Dashboard",
  LIST_DETAIL: "List + Detail",
  FORM: "Form",
  EDITOR: "Editor",
  SETTINGS: "Settings",
  DETAIL: "Detail",
  LANDING: "Landing",
  WIZARD: "Wizard",
  SEARCH: "Search",
  AUTH: "Auth",
  OTHER: "Other",
};

/**
 * One-line shape descriptions — surfaced as helper text on the shell
 * dropdown and embedded in the rendered markdown. Lifted from the
 * recipe summaries in wireframe-recipes.ts (compressed to one line).
 */
export const SHELL_TYPE_DESCRIPTIONS: Record<ShellType, string> = {
  DASHBOARD: "KPI cards + main modules + optional activity rail",
  LIST_DETAIL: "Filter rail + results list + selection detail panel",
  FORM: "Structured form fields + support rail + action footer",
  EDITOR: "Toolbar + library + canvas + inspector",
  SETTINGS: "Side nav + content panels + help rail",
  DETAIL: "Hero + narrative sections + metadata rail",
  LANDING: "Marketing hero + feature strip + CTA + footer",
  WIZARD: "Linear stepper + step content + support rail",
  SEARCH: "Search field + filter rail + results",
  AUTH: "Centered auth card + secondary actions",
  OTHER: "Custom shape — describe in notes",
};

// ---------------------------------------------------------------------------
// Screen + canvas schemas
// ---------------------------------------------------------------------------

/**
 * A single screen in the product. Intentionally narrow: name, shell,
 * description, mappings to spec features + entities, free-text notes.
 * No element list, no layout bounds — those belong in Stitch's output,
 * not here.
 */
export const ScreenSchema = z.object({
  /** Stable id used for cross-references. */
  id: z.string(),
  /** Imperative name — "Sign up", "Project list", "Account settings". */
  name: z.string().default(""),
  /** What the user does on this screen, in user terms. */
  description: z.string().default(""),
  /** Layout shape — drives stitch pack direction and audit checks. */
  shellType: ShellTypeSchema.default("DASHBOARD"),
  /**
   * Feature ids from `spec-canvas.json` features[] this screen
   * fulfills. Drives the audit's "every Must feature has a screen"
   * coverage rule and feeds the stitch pack with per-screen feature
   * context.
   */
  featureIds: z.array(z.string()).default([]),
  /**
   * Entity ids from `spec-canvas.json` dataModel.entities[] this
   * screen reads/writes. Optional — informational, not gated.
   */
  entityIds: z.array(z.string()).default([]),
  /**
   * Free-text notes — responsive behavior, edge states, empty-state
   * copy hints, anything the shellType doesn't capture.
   */
  notes: z.string().default(""),
});
export type Screen = z.infer<typeof ScreenSchema>;

/**
 * The on-disk canvas at `06_product/wireframes/screens-canvas.json`.
 * Versioned so we can evolve without corrupting existing files.
 */
export const ScreensCanvasSchema = z.object({
  ventureId: z.string(),
  screens: z.array(ScreenSchema).default([]),
  /** Free-text notes about the overall screen architecture. */
  notes: z.string().default(""),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().default(1),
});
export type ScreensCanvas = z.infer<typeof ScreensCanvasSchema>;

/**
 * Build a fresh canvas. Called by the pipeline step when no existing
 * canvas is present. Empty screens — the founder fills via ScreensTab
 * (or, if pt.43c lands later, the AI-assisted drafter).
 */
export function createEmptyScreensCanvas(ventureId: string): ScreensCanvas {
  const now = new Date().toISOString();
  return ScreensCanvasSchema.parse({
    ventureId,
    createdAt: now,
    updatedAt: now,
  });
}

// ---------------------------------------------------------------------------
// Must-haves derivation
// ---------------------------------------------------------------------------

export type ScreensRule = {
  id: string;
  label: string;
  description: string;
  pass: boolean;
};

/**
 * Narrow snapshot of the spec canvas used by `deriveScreensRules`.
 * Defined here (not imported from `./spec.js`) to avoid a circular
 * dependency: spec.ts already gets re-exported from index.ts and so
 * does this file; importing across files at module load creates a
 * cycle. We only need features (id + name + priority) for the
 * coverage rule, so a minimal structural type is cheaper than a full
 * cross-import.
 */
export type ScreensRuleSpecSnapshot = {
  features: Array<{ id: string; name: string; priority: string }>;
};

/**
 * Compute must-haves from the canvas + a spec snapshot. Single source
 * of truth shared with the ScreensTab's must-haves panel and the
 * audit step (pt.43, audit section in audit-venture.ts).
 *
 * Adding a new rule here makes it appear in BOTH the UI checklist and
 * the audit findings (with severity from `SCREEN_RULE_SEVERITY` in
 * audit-venture.ts).
 */
export function deriveScreensRules(
  canvas: ScreensCanvas,
  spec: ScreensRuleSpecSnapshot
): ScreensRule[] {
  const rules: ScreensRule[] = [];

  const namedScreens = canvas.screens.filter(
    (s) => s.name.trim().length > 0
  );

  // Bare rule ids (no "screens." prefix) — the audit prepends the
  // namespace when emitting findings, matching the spec pattern
  // (`deriveProductSpecRules` emits "purpose.set" etc., audit makes
  // those "spec.purpose.set"). Keep the same convention here so the
  // SCREEN_RULE_SEVERITY map keys stay short and the ruleId-prefix
  // policy is consistent across stages.
  rules.push({
    id: "at-least-one",
    label: "At least one screen",
    description: "Every product has at least one screen the user lands on",
    pass: namedScreens.length > 0,
  });

  rules.push({
    id: "shell-types-set",
    label: "Every screen has a shell type",
    description:
      "Stitch / v0 / Figma Make get richer direction when each screen names its layout shell",
    // Trivially true for empty canvas — pair with at-least-one to
    // gate the empty case. shellType has a default of DASHBOARD so
    // the only failure mode here is a future schema change leaving
    // it optional; we keep the check defensively.
    pass:
      namedScreens.length > 0 &&
      namedScreens.every((s) => s.shellType !== undefined),
  });

  // Coverage rule — only fires if there ARE Must features to cover.
  // No Must features → spec is the gap, not screens; the spec stage
  // already flags this via `features.at-least-one-must`.
  const mustFeatures = spec.features.filter(
    (f) => f.priority === "must" && f.name.trim().length > 0
  );
  if (mustFeatures.length > 0) {
    const coveredFeatureIds = new Set<string>();
    for (const screen of namedScreens) {
      for (const fid of screen.featureIds) {
        if (fid.trim()) coveredFeatureIds.add(fid);
      }
    }
    rules.push({
      id: "must-feature-coverage",
      label: "Every Must feature has a screen",
      description:
        "Each Must-priority feature is fulfilled by at least one screen",
      pass: mustFeatures.every((f) => coveredFeatureIds.has(f.id)),
    });
  }

  return rules;
}

/**
 * Convenience — true when every applicable rule passes. The UI uses
 * this to gate the green "ready to advance to Stitch" pill.
 */
export function isScreensCanvasComplete(
  canvas: ScreensCanvas,
  spec: ScreensRuleSpecSnapshot
): boolean {
  return deriveScreensRules(canvas, spec).every((r) => r.pass);
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

/**
 * Optional context for `renderScreensMarkdown` — when the spec snapshot
 * is provided, feature/entity ids in the canvas resolve to human names
 * in the rendered output. Without it, raw ids get printed (still
 * useful as a fallback).
 */
export type ScreensMarkdownContext = {
  ventureName?: string;
  spec?: {
    features: Array<{ id: string; name: string }>;
    dataModel: { entities: Array<{ id: string; name: string }> };
  };
};

/**
 * Render the canvas as a human-friendly markdown document. The
 * pipeline step writes this to `06_product/wireframes/screens.md` on
 * every run so non-app readers (collaborators, future-you outside the
 * app, exports) can see the inventory without parsing JSON.
 *
 * Pure data → string; no IO. Lives in `domain` so any package can
 * call it (pipeline step, exports, tests) without pulling in node:fs.
 */
export function renderScreensMarkdown(
  canvas: ScreensCanvas,
  ctx?: ScreensMarkdownContext
): string {
  const ventureName = ctx?.ventureName ?? "";

  const featuresById = new Map<string, string>();
  const entitiesById = new Map<string, string>();
  if (ctx?.spec) {
    for (const f of ctx.spec.features) featuresById.set(f.id, f.name);
    for (const e of ctx.spec.dataModel.entities) {
      entitiesById.set(e.id, e.name);
    }
  }

  const resolveFeatureLabels = (ids: string[]): string[] =>
    ids
      .map((id) => (featuresById.get(id) || id || "").trim())
      .filter((s) => s.length > 0);
  const resolveEntityLabels = (ids: string[]): string[] =>
    ids
      .map((id) => (entitiesById.get(id) || id || "").trim())
      .filter((s) => s.length > 0);

  const lines: string[] = [];
  lines.push(
    `# Screens${ventureName ? ` — ${ventureName}` : ""}`,
    "",
    "_Derived view — edit `screens-canvas.json` (or the Screens tab in the desktop app) instead. This file is regenerated on every pipeline run._",
    ""
  );

  const named = canvas.screens.filter((s) => s.name.trim().length > 0);
  if (named.length === 0) {
    lines.push("_No screens defined yet._", "");
    if (canvas.notes.trim()) {
      lines.push("## Notes", "", canvas.notes.trim(), "");
    }
    return lines.join("\n");
  }

  // Inventory table — the at-a-glance overview.
  lines.push("## Inventory", "");
  lines.push(
    "| Screen | Shell | Features | Entities |",
    "|--------|-------|----------|----------|"
  );
  for (const s of named) {
    const flabels = resolveFeatureLabels(s.featureIds).join(", ");
    const elabels = resolveEntityLabels(s.entityIds).join(", ");
    lines.push(
      `| ${s.name.trim().replace(/\|/g, "\\|")} | ${s.shellType} | ${
        flabels.replace(/\|/g, "\\|") || "—"
      } | ${elabels.replace(/\|/g, "\\|") || "—"} |`
    );
  }
  lines.push("");

  // Per-screen detail blocks.
  lines.push("## Detail", "");
  for (const s of named) {
    lines.push(`### ${s.name.trim()}`);
    lines.push(
      "",
      `**Shell:** ${SHELL_TYPE_LABELS[s.shellType]} — ${SHELL_TYPE_DESCRIPTIONS[s.shellType]}`
    );
    if (s.description.trim()) {
      lines.push("", s.description.trim());
    }
    const flabels = resolveFeatureLabels(s.featureIds);
    if (flabels.length > 0) {
      lines.push("", "**Fulfills features:**");
      for (const f of flabels) lines.push(`- ${f}`);
    }
    const elabels = resolveEntityLabels(s.entityIds);
    if (elabels.length > 0) {
      lines.push("", "**Touches entities:**");
      for (const e of elabels) lines.push(`- ${e}`);
    }
    if (s.notes.trim()) {
      lines.push("", `**Notes:** ${s.notes.trim()}`);
    }
    lines.push("");
  }

  if (canvas.notes.trim()) {
    lines.push("## Notes", "", canvas.notes.trim(), "");
  }

  return lines.join("\n");
}
