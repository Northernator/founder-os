/**
 * Wireframes step -- turns the screens canvas
 * (06_product/wireframes/screens-canvas.json) plus the spec canvas
 * (06_product/specs/spec-canvas.json) into per-screen wireframe specs:
 * a structured JSON checkpoint and a founder-facing markdown readout
 * with Mermaid block diagrams.
 *
 * Inputs
 * ------
 *  - `manifest`       venture.yaml (id/name/appType)
 *  - `ventureRoot`    absolute venture folder
 *  - `callLlm`        optional SaaS-style caller. When provided, each
 *                     screen\'s "Layout & states" narrative is LLM-
 *                     written from the screen description + spec
 *                     snippet. Without it we render a deterministic
 *                     templated narrative keyed off the shellType.
 *  - `fs`             injected Filesystem
 *
 * Outputs (under 06_product/wireframes/)
 * --------------------------------------
 *   wireframe-checkpoint.json -- structured per-screen contract
 *   wireframes.md             -- founder-facing layout readout
 *
 * Behaviour
 * ---------
 *  - Re-running overwrites both files with the latest screens-canvas
 *    state. The screens canvas itself is never touched.
 *  - LLM failures are non-fatal: each screen falls back to its
 *    deterministic narrative independently, and `generationSource`
 *    flips to "deterministic-fallback" if any screen used the
 *    fallback.
 *  - Empty screens canvas (zero screens) is fine -- we still write
 *    both files so downstream tools have something to reference,
 *    flagged as "no screens defined" in the markdown.
 *
 * The structured JSON is shape-stable (schemaVersion: 1). Adding
 * fields is allowed; renaming/removing breaks downstream and bumps
 * the version.
 */
import {
  ProductSpecCanvasSchema,
  ScreensCanvasSchema,
  type Screen as ScreenCanvasEntry,
  type ShellType,
  type VentureManifest,
} from "@founder-os/domain";
import { createLogger } from "@founder-os/logger";
import {
  getScreensCanvasPath,
  getSpecCanvasPath,
  getWireframesDir,
} from "@founder-os/workspace-core";
import type { Filesystem } from "../fs.js";
import type { SaasLlmCaller } from "./create-saas-research-reports.js";

const log = createLogger("pipeline-runner:create-wireframes");

/** Stable schema for the structured wireframe checkpoint. */
export type WireframeCheckpointJson = {
  schemaVersion: 1;
  stage: "WIREFRAME";
  runId: string;
  ventureId: string;
  ventureName: string;
  createdAt: string;
  /** Where the screens canvas lived when this was produced. */
  derivedFrom: string;
  screens: WireframeScreen[];
  summary: {
    totalScreens: number;
    /** Counts per ShellType (sparse -- keys with 0 omitted). */
    shellTypeCounts: Record<string, number>;
  };
  sources: string[];
  generationSource: "llm" | "deterministic-fallback" | "deterministic";
};

export type WireframeScreen = {
  id: string;
  name: string;
  shellType: ShellType;
  description: string;
  /** Templated or LLM-written narrative covering layout + states. */
  layout: string;
  /** Mermaid block diagram source ("```mermaid ... ```" body, no fences). */
  mermaid: string;
  /** Per-state copy ideas. */
  states: { name: string; note: string }[];
  /** A11y notes scoped to this screen. */
  accessibility: string[];
  featureIds: string[];
  entityIds: string[];
  /** "llm" if this specific screen\'s narrative was LLM-written. */
  source: "llm" | "deterministic";
};

export type CreateWireframesContext = {
  fs: Filesystem;
  manifest: VentureManifest;
  ventureRoot: string;
  callLlm?: SaasLlmCaller;
  deepResearch?: { filename: string; excerpt: string }[];
  runId?: string;
};

export type CreateWireframesResult = {
  status: "done";
  jsonPath: string;
  mdPath: string;
  checkpoint: WireframeCheckpointJson;
};

const SCREEN_LLM_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Spec canvas snapshot used to resolve featureId/entityId labels in
// the markdown. Kept structural (not the full Zod type) so we can
// degrade gracefully when fields are missing.
// ---------------------------------------------------------------------------

type SpecSnapshot = {
  features: { id: string; name: string; priority: string }[];
  entities: { id: string; name: string }[];
};

const EMPTY_SPEC: SpecSnapshot = { features: [], entities: [] };

async function readSpecSnapshot(
  fs: Filesystem,
  ventureRoot: string
): Promise<{ spec: SpecSnapshot; sourcePresent: boolean }> {
  const path = getSpecCanvasPath(ventureRoot);
  if (!(await fs.exists(path))) return { spec: EMPTY_SPEC, sourcePresent: false };
  try {
    const raw = await fs.readFile(path);
    const parsed = ProductSpecCanvasSchema.parse(JSON.parse(raw));
    return {
      spec: {
        features: parsed.features.map((f) => ({
          id: f.id,
          name: f.name,
          priority: f.priority,
        })),
        entities: parsed.dataModel.entities.map((e) => ({ id: e.id, name: e.name })),
      },
      sourcePresent: true,
    };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    log.warn(`spec-canvas.json present but unparseable -- using empty spec snapshot: ${m}`);
    return { spec: EMPTY_SPEC, sourcePresent: false };
  }
}

// ---------------------------------------------------------------------------
// Deterministic templates
// ---------------------------------------------------------------------------

/**
 * Per-shellType Mermaid block diagram. Pure function, used as the
 * baseline when no LLM is wired (and as a starting point the LLM
 * narrative wraps prose around).
 */
export function defaultMermaidForShellType(shell: ShellType): string {
  switch (shell) {
    case "DASHBOARD":
      return [
        "flowchart TB",
        "  Header[Top bar -- nav + user menu]",
        "  Sidebar[Left sidebar -- primary nav]",
        "  KPIs[KPI strip]",
        "  Grid[Card grid -- key metrics + recent activity]",
        "  Header --> Sidebar",
        "  Header --> KPIs",
        "  KPIs --> Grid",
      ].join("\n");
    case "LIST_DETAIL":
      return [
        "flowchart LR",
        "  List[Master list -- searchable + filterable]",
        "  Toolbar[Toolbar -- New / Filter / Sort]",
        "  Detail[Detail pane -- selected item]",
        "  Toolbar --> List",
        "  List --> Detail",
      ].join("\n");
    case "FORM":
      return [
        "flowchart TB",
        "  Title[Title + summary]",
        "  Fields[Field stack -- grouped by section]",
        "  Help[Inline help / validation]",
        "  Actions[Submit / Cancel actions]",
        "  Title --> Fields",
        "  Fields --> Help",
        "  Fields --> Actions",
      ].join("\n");
    case "EDITOR":
      return [
        "flowchart LR",
        "  Toolbar[Toolbar -- formatting + actions]",
        "  Tree[Outline / asset tree]",
        "  Canvas[Editor canvas]",
        "  Inspector[Inspector / properties pane]",
        "  Toolbar --> Canvas",
        "  Tree --> Canvas",
        "  Canvas --> Inspector",
      ].join("\n");
    case "SETTINGS":
      return [
        "flowchart LR",
        "  Sections[Settings sections nav]",
        "  Body[Section body -- forms / toggles]",
        "  Save[Persistent save bar]",
        "  Sections --> Body",
        "  Body --> Save",
      ].join("\n");
    case "DETAIL":
      return [
        "flowchart TB",
        "  Header[Header -- title + breadcrumbs]",
        "  Summary[Summary card -- key metadata]",
        "  Tabs[Tabs -- Overview / History / Activity]",
        "  Body[Tab body content]",
        "  Header --> Summary",
        "  Summary --> Tabs",
        "  Tabs --> Body",
      ].join("\n");
    case "LANDING":
      return [
        "flowchart TB",
        "  Hero[Hero -- headline + primary CTA]",
        "  Value[Value props -- 3 pillars]",
        "  Social[Social proof / logos]",
        "  CTA[Closing CTA]",
        "  Hero --> Value",
        "  Value --> Social",
        "  Social --> CTA",
      ].join("\n");
    case "WIZARD":
      return [
        "flowchart LR",
        "  Steps[Step indicator]",
        "  Body[Current step body]",
        "  Nav[Back / Next / Skip]",
        "  Steps --> Body",
        "  Body --> Nav",
      ].join("\n");
    case "SEARCH":
      return [
        "flowchart TB",
        "  Bar[Search bar -- query + filters]",
        "  Facets[Facet sidebar]",
        "  Results[Results list]",
        "  Pagination[Pagination / load more]",
        "  Bar --> Facets",
        "  Facets --> Results",
        "  Results --> Pagination",
      ].join("\n");
    case "AUTH":
      return [
        "flowchart TB",
        "  Brand[Brand mark]",
        "  Form[Auth form -- email + password / OAuth]",
        "  Help[Forgot password / sign up link]",
        "  Brand --> Form",
        "  Form --> Help",
      ].join("\n");
    default:
      return [
        "flowchart TB",
        "  Header[Header]",
        "  Body[Body]",
        "  Footer[Footer]",
        "  Header --> Body",
        "  Body --> Footer",
      ].join("\n");
  }
}

/** Per-shellType states list. Tweakable per screen via canvas notes. */
function defaultStatesForShellType(shell: ShellType): { name: string; note: string }[] {
  const base = [
    { name: "loading", note: "Skeleton placeholders for the primary regions." },
    { name: "empty", note: "First-time empty -- explain the value + provide a primary CTA." },
    { name: "error", note: "Inline error banner with retry; preserve any user input." },
  ];
  if (shell === "FORM" || shell === "WIZARD") {
    return [
      ...base,
      {
        name: "validation",
        note: "Per-field inline validation; submit disabled until required fields valid.",
      },
      { name: "submitted", note: "Success confirmation + next-step link." },
    ];
  }
  if (shell === "LIST_DETAIL" || shell === "SEARCH") {
    return [
      ...base,
      { name: "no-results", note: "Differentiate empty-collection from filtered-empty." },
      { name: "selected", note: "Detail pane / row highlight; preserve scroll on update." },
    ];
  }
  if (shell === "AUTH") {
    return [
      ...base,
      {
        name: "rate-limited",
        note: "Friendly cooldown message + path to password reset.",
      },
    ];
  }
  return base;
}

/** Minimal a11y baseline. Screens add specifics via canvas notes. */
function defaultAccessibilityNotes(shell: ShellType): string[] {
  const base = [
    "All interactive elements reachable via keyboard with visible focus rings.",
    "Colour is never the only signal -- pair status colour with an icon or label.",
    "Live regions announce loading/error transitions to screen readers.",
  ];
  if (shell === "FORM" || shell === "WIZARD") {
    return [
      ...base,
      "Each input has an explicit <label>; required fields announced.",
      "Error summary at the top of the form on submit-fail.",
    ];
  }
  if (shell === "LIST_DETAIL" || shell === "SEARCH") {
    return [
      ...base,
      "Selection model uses ARIA listbox / grid roles; arrow-key navigation.",
    ];
  }
  if (shell === "EDITOR") {
    return [
      ...base,
      "Keyboard shortcuts documented in a discoverable help dialog.",
      "Toolbar buttons exposed as a toolbar role with aria-label per action.",
    ];
  }
  return base;
}

function deterministicLayoutNarrative(
  screen: ScreenCanvasEntry,
  spec: SpecSnapshot
): string {
  const featureNames = screen.featureIds
    .map((id) => spec.features.find((f) => f.id === id)?.name ?? id)
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  const entityNames = screen.entityIds
    .map((id) => spec.entities.find((e) => e.id === id)?.name ?? id)
    .filter((s): s is string => typeof s === "string" && s.length > 0);

  const parts: string[] = [];
  parts.push(
    `Layout follows the **${humanShell(screen.shellType)}** shell pattern -- see the Mermaid diagram above for the regions.`
  );
  if (screen.description.trim()) {
    parts.push(`Purpose: ${screen.description.trim()}`);
  }
  if (featureNames.length > 0) {
    parts.push(`Fulfils features: ${featureNames.join(", ")}.`);
  }
  if (entityNames.length > 0) {
    parts.push(`Reads/writes entities: ${entityNames.join(", ")}.`);
  }
  if (screen.notes.trim()) {
    parts.push(`Founder notes: ${screen.notes.trim()}`);
  }
  return parts.join(" ");
}

const SHELL_LABELS: Record<ShellType, string> = {
  DASHBOARD: "Dashboard",
  LIST_DETAIL: "List + detail",
  FORM: "Form",
  EDITOR: "Editor",
  SETTINGS: "Settings",
  DETAIL: "Detail page",
  LANDING: "Landing",
  WIZARD: "Wizard",
  SEARCH: "Search",
  AUTH: "Auth",
  OTHER: "Other",
};

function humanShell(shell: ShellType): string {
  return SHELL_LABELS[shell];
}

// ---------------------------------------------------------------------------
// LLM enrichment
// ---------------------------------------------------------------------------

const LAYOUT_SYSTEM_PROMPT = `You are writing the "Layout & states" narrative for a single low-fidelity wireframe spec for a SaaS product.

Output rules:
- Output 2-4 short paragraphs of plain prose. NO headings, NO bullet lists, NO markdown code fences.
- Be specific to THIS screen: cite the description, shell type, features it fulfils, and entities it reads/writes.
- Cover (in this order): primary regions and where the user\'s eye lands first; the most important action and how it\'s surfaced; how loading / empty / error states behave; one accessibility consideration tied to the shell type.
- UK context: GBP for money, regulators are Companies House / HMRC / ICO / FCA when relevant.
- Roughly 150-280 words. No filler.`;

function buildLayoutUserPrompt(args: {
  manifest: VentureManifest;
  screen: ScreenCanvasEntry;
  spec: SpecSnapshot;
  deepResearch?: { filename: string; excerpt: string }[];
}): string {
  const featureNames = args.screen.featureIds.map((id) => {
    const f = args.spec.features.find((x) => x.id === id);
    return f ? `${f.name} (${f.priority})` : id;
  });
  const entityNames = args.screen.entityIds.map((id) => {
    const e = args.spec.entities.find((x) => x.id === id);
    return e ? e.name : id;
  });
  const researchBlock = args.deepResearch?.length
    ? args.deepResearch.map((r) => `### ${r.filename}\n\n${r.excerpt}`).join("\n\n")
    : "(none)";
  return `Write the **Layout & states** narrative for the screen "${args.screen.name}" in the SaaS venture "${args.manifest.name}".

Screen metadata:
- Shell type: ${humanShell(args.screen.shellType)}
- Description: ${args.screen.description.trim() || "(none provided)"}
- Features fulfilled: ${featureNames.length > 0 ? featureNames.join(", ") : "(none)"}
- Entities touched: ${entityNames.length > 0 ? entityNames.join(", ") : "(none)"}
- Founder notes: ${args.screen.notes.trim() || "(none)"}

Deep research context:
${researchBlock}`;
}

async function enrichScreen(args: {
  manifest: VentureManifest;
  screen: ScreenCanvasEntry;
  spec: SpecSnapshot;
  callLlm: SaasLlmCaller;
  deepResearch?: { filename: string; excerpt: string }[];
}): Promise<{ narrative: string; usedLlm: boolean }> {
  try {
    const text = await args.callLlm({
      system: LAYOUT_SYSTEM_PROMPT,
      user: buildLayoutUserPrompt({
        manifest: args.manifest,
        screen: args.screen,
        spec: args.spec,
        deepResearch: args.deepResearch,
      }),
    });
    const cleaned = text.trim();
    if (!cleaned) throw new Error("LLM returned empty narrative");
    return { narrative: cleaned, usedLlm: true };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    log.warn(`Wireframe LLM enrichment failed for screen "${args.screen.name}": ${m}`);
    return {
      narrative: deterministicLayoutNarrative(args.screen, args.spec),
      usedLlm: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderMarkdown(args: {
  manifest: VentureManifest;
  screens: WireframeScreen[];
  spec: SpecSnapshot;
  derivedFrom: string;
  generationSource: WireframeCheckpointJson["generationSource"];
}): string {
  const lines: string[] = [];
  lines.push(`# Wireframes -- ${args.manifest.name}`);
  lines.push("");
  lines.push(
    `Derived from \u0060${args.derivedFrom}\u0060. Re-runs overwrite this file with the latest screens canvas state.`
  );
  lines.push("");

  if (args.screens.length === 0) {
    lines.push(
      "_No screens defined yet. Add screens via the Screens tab, then re-run the wireframe stage._"
    );
    lines.push("");
    return lines.join("\n");
  }

  // TOC
  lines.push("## Screens");
  for (const s of args.screens) {
    const slug = slugify(s.name || s.id);
    lines.push(`- [${s.name || s.id}](#${slug}) -- ${humanShell(s.shellType)}`);
  }
  lines.push("");

  for (const s of args.screens) {
    lines.push(`## ${s.name || s.id}`);
    lines.push("");
    lines.push(`Shell: **${humanShell(s.shellType)}**`);
    if (s.description.trim()) {
      lines.push("");
      lines.push(s.description.trim());
    }
    lines.push("");
    lines.push("### Layout");
    lines.push("");
    lines.push("\u0060\u0060\u0060mermaid");
    lines.push(s.mermaid);
    lines.push("\u0060\u0060\u0060");
    lines.push("");
    lines.push("### Layout & states");
    lines.push("");
    lines.push(s.layout);
    lines.push("");
    lines.push("### States");
    for (const st of s.states) {
      lines.push(`- **${st.name}** -- ${st.note}`);
    }
    lines.push("");
    lines.push("### Accessibility");
    for (const a of s.accessibility) {
      lines.push(`- ${a}`);
    }
    lines.push("");
    if (s.featureIds.length > 0 || s.entityIds.length > 0) {
      lines.push("### Spec links");
      for (const id of s.featureIds) {
        const f = args.spec.features.find((x) => x.id === id);
        lines.push(`- Feature \u0060${id}\u0060${f ? ` -- ${f.name} (${f.priority})` : ""}`);
      }
      for (const id of s.entityIds) {
        const e = args.spec.entities.find((x) => x.id === id);
        lines.push(`- Entity \u0060${id}\u0060${e ? ` -- ${e.name}` : ""}`);
      }
      lines.push("");
    }
  }

  lines.push(
    `_Generation source: ${args.generationSource}. Re-run with a configured LLM provider for richer narratives._`
  );
  lines.push("");
  return lines.join("\n");
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "screen";
}

// ---------------------------------------------------------------------------
// Concurrency-capped pool (mirrors create-saas-research-reports).
// ---------------------------------------------------------------------------

async function runWithConcurrency<T>(
  limit: number,
  tasks: Array<() => Promise<T>>
): Promise<T[]> {
  if (tasks.length === 0) return [];
  const results: T[] = new Array(tasks.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= tasks.length) return;
      const task = tasks[i];
      if (task) results[i] = await task();
    }
  };
  const workerCount = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// ---------------------------------------------------------------------------
// Main step
// ---------------------------------------------------------------------------

export async function createWireframesStep(
  ctx: CreateWireframesContext
): Promise<CreateWireframesResult> {
  const dir = getWireframesDir(ctx.ventureRoot);
  await ctx.fs.mkdir(dir);

  const screensCanvasPath = getScreensCanvasPath(ctx.ventureRoot);
  if (!(await ctx.fs.exists(screensCanvasPath))) {
    // Runner\'s validate() should have caught this; throw with a
    // matching message so the runner\'s catch maps cleanly.
    throw new Error(
      `screens canvas missing at ${screensCanvasPath} (run PRODUCT_SPEC stage first)`
    );
  }

  let canvasParsed: { ventureId: string; screens: ScreenCanvasEntry[]; notes: string };
  try {
    const raw = await ctx.fs.readFile(screensCanvasPath);
    canvasParsed = ScreensCanvasSchema.parse(JSON.parse(raw));
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    throw new Error(`screens canvas at ${screensCanvasPath} is unparseable: ${m}`);
  }

  const { spec, sourcePresent: specPresent } = await readSpecSnapshot(
    ctx.fs,
    ctx.ventureRoot
  );
  const sources: string[] = ["screens-canvas.json"];
  if (specPresent) sources.push("spec-canvas.json");
  for (const r of ctx.deepResearch ?? []) sources.push(r.filename);

  const runId = ctx.runId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const screenTasks: Array<() => Promise<WireframeScreen>> = canvasParsed.screens.map(
    (screen) => async () => {
      const mermaid = defaultMermaidForShellType(screen.shellType);
      const states = defaultStatesForShellType(screen.shellType);
      const accessibility = defaultAccessibilityNotes(screen.shellType);
      let narrative: string;
      let source: WireframeScreen["source"];
      if (ctx.callLlm) {
        const out = await enrichScreen({
          manifest: ctx.manifest,
          screen,
          spec,
          callLlm: ctx.callLlm,
          deepResearch: ctx.deepResearch,
        });
        narrative = out.narrative;
        source = out.usedLlm ? "llm" : "deterministic";
      } else {
        narrative = deterministicLayoutNarrative(screen, spec);
        source = "deterministic";
      }
      return {
        id: screen.id,
        name: screen.name,
        shellType: screen.shellType,
        description: screen.description,
        layout: narrative,
        mermaid,
        states,
        accessibility,
        featureIds: screen.featureIds,
        entityIds: screen.entityIds,
        source,
      };
    }
  );

  const wireframeScreens = await runWithConcurrency(SCREEN_LLM_CONCURRENCY, screenTasks);

  const shellCounts: Record<string, number> = {};
  for (const s of wireframeScreens) {
    shellCounts[s.shellType] = (shellCounts[s.shellType] ?? 0) + 1;
  }

  let generationSource: WireframeCheckpointJson["generationSource"];
  if (!ctx.callLlm) {
    generationSource = "deterministic";
  } else if (wireframeScreens.length === 0) {
    generationSource = "deterministic";
  } else if (wireframeScreens.every((s) => s.source === "llm")) {
    generationSource = "llm";
  } else {
    // At least one screen fell back. Even one regression matters
    // because the founder asked for LLM enrichment.
    generationSource = "deterministic-fallback";
  }

  const checkpoint: WireframeCheckpointJson = {
    schemaVersion: 1,
    stage: "WIREFRAME",
    runId,
    ventureId: ctx.manifest.id,
    ventureName: ctx.manifest.name,
    createdAt: new Date().toISOString(),
    derivedFrom: screensCanvasPath,
    screens: wireframeScreens,
    summary: {
      totalScreens: wireframeScreens.length,
      shellTypeCounts: shellCounts,
    },
    sources,
    generationSource,
  };

  const jsonPath = `${dir}/wireframe-checkpoint.json`;
  const mdPath = `${dir}/wireframes.md`;

  await ctx.fs.writeFile(jsonPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
  const md = renderMarkdown({
    manifest: ctx.manifest,
    screens: wireframeScreens,
    spec,
    derivedFrom: screensCanvasPath,
    generationSource,
  });
  await ctx.fs.writeFile(mdPath, md.endsWith("\n") ? md : `${md}\n`);

  log.info(
    `Wireframes written (${wireframeScreens.length} screens, generationSource: ${generationSource})`
  );

  return { status: "done", jsonPath, mdPath, checkpoint };
}
