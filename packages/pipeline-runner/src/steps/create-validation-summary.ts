/**
 * Validation summary step -- synthesises the ValidationTab canvas
 * (02_validation/validation-canvas.json) and any SaaS research
 * outputs (01_research/saas/*.md) into a stable go/no-go summary
 * that downstream stages and the desktop UI can read.
 *
 * Inputs
 * ------
 *  - `manifest`       venture.yaml (id/name/appType)
 *  - `ventureRoot`    absolute venture folder
 *  - `callLlm`        optional SaaS-style caller. When provided, the
 *                     markdown narrative section ("Go/no-go take") is
 *                     LLM-generated from the canvas + research excerpts.
 *                     When absent, a deterministic templated narrative
 *                     is written so the step still produces a useful
 *                     summary without a configured provider.
 *  - `fs`             injected Filesystem
 *
 * Outputs (under 02_validation/)
 * ------------------------------
 *   validation-summary.md    -- founder-facing readout
 *   validation-summary.json  -- structured ValidationSummaryJson
 *
 * Behaviour
 * ---------
 *  - Always writes both files. Re-running overwrites them with the
 *    latest canvas state -- the canvas is the source of truth, so a
 *    summary regen is cheap and never destroys founder data.
 *  - Idempotency is at the canvas level: the canvas is not touched.
 *  - Sparse inputs are fine. Missing canvas -> defaults; non-saas
 *    appType -> research excerpts skipped; empty research dir -> note
 *    that no reports were available.
 *  - LLM failures are non-fatal: the deterministic narrative is used
 *    as a fallback and `summarySource` flips to "deterministic-fallback".
 *
 * The structured JSON is shape-stable (schemaVersion: 1). Adding a
 * field is allowed; renaming or removing one breaks downstream
 * consumers and bumps the schema version.
 */
import type { VentureManifest } from "@founder-os/domain";
import { createLogger } from "@founder-os/logger";
import { getStagePath } from "@founder-os/workspace-core";
import type { Filesystem } from "../fs.js";
import type { SaasLlmCaller } from "./create-saas-research-reports.js";

const log = createLogger("pipeline-runner:create-validation-summary");

/** Stable schema for the structured summary file. */
export type ValidationSummaryJson = {
  schemaVersion: 1;
  stage: "VALIDATION";
  runId: string;
  ventureId: string;
  ventureName: string;
  createdAt: string;
  /** Founder-set decision; mirrors ValidationCanvas.validationDecision. */
  decision: "validated" | "pivot" | "invalidated" | "undecided";
  decisionReason: string;
  icp: { description: string; role: string; pain: string };
  offer: { valueProposition: string; whatsIncluded: string; whatsExcluded: string };
  pricing: { pricePoint: string; pricingModel: string };
  experiments: { total: number; done: number; running: number; planned: number };
  keyLearnings: string;
  whatChanged: string;
  /** Computed must-haves; mirrors ValidationTab\'s checks. */
  musthaves: {
    icpDefined: boolean;
    offerDefined: boolean;
    pricingDecided: boolean;
    experimentRun: boolean;
    resultsDocumented: boolean;
    decisionMade: boolean;
    allMet: boolean;
  };
  /** Files this summary read from. Filenames only (basenames). */
  sources: string[];
  /** Whether the markdown narrative came from LLM or deterministic template. */
  summarySource: "llm" | "deterministic-fallback" | "deterministic";
};

export type CreateValidationSummaryContext = {
  fs: Filesystem;
  manifest: VentureManifest;
  ventureRoot: string;
  /** Optional SaaS-style LLM caller. Omit for deterministic-only. */
  callLlm?: SaasLlmCaller;
  /** Optional deep-research briefings gathered by stage-runners before this step. */
  deepResearch?: { filename: string; excerpt: string }[];
  /** Optional explicit runId; the runner forwards its own. */
  runId?: string;
};

export type CreateValidationSummaryResult = {
  status: "done";
  jsonPath: string;
  mdPath: string;
  summary: ValidationSummaryJson;
};

// ---------------------------------------------------------------------------
// Canvas types -- mirror ValidationTab.tsx exactly (kept here as a local
// shape rather than imported from @founder-os/domain to avoid a circular
// dependency: ValidationTab lives in apps/founder-desktop and the canvas
// is currently a UI-only schema). If/when ValidationCanvas migrates into
// @founder-os/domain we replace these locals with the shared type.
// ---------------------------------------------------------------------------

type ValidationDecision = "validated" | "pivot" | "invalidated" | "undecided";
type ExperimentStatus = "planned" | "running" | "done";

type Experiment = {
  status: ExperimentStatus;
  description: string;
};

type ValidationCanvas = {
  icpDescription: string;
  icpRole: string;
  icpPain: string;
  icpCurrentSolution: string;
  icpTrigger: string;
  valueProposition: string;
  whatsIncluded: string;
  whatsExcluded: string;
  pricePoint: string;
  pricingModel: string;
  priceSensitivityNotes: string;
  experiments: Experiment[];
  keyLearnings: string;
  whatChanged: string;
  validationDecision: ValidationDecision;
  decisionReason: string;
  updatedAt: string;
};

const EMPTY_CANVAS: ValidationCanvas = {
  icpDescription: "",
  icpRole: "",
  icpPain: "",
  icpCurrentSolution: "",
  icpTrigger: "",
  valueProposition: "",
  whatsIncluded: "",
  whatsExcluded: "",
  pricePoint: "",
  pricingModel: "",
  priceSensitivityNotes: "",
  experiments: [],
  keyLearnings: "",
  whatChanged: "",
  validationDecision: "undecided",
  decisionReason: "",
  updatedAt: "",
};

// Reports we proactively excerpt for the LLM context. Picked because
// they shape the go/no-go: market shape, ICP, pricing willingness.
// Other reports are fine to ignore -- the canvas is the primary input.
const PRIORITY_RESEARCH_REPORTS = [
  "market-research.md",
  "prd.md",
  "business-model-and-pricing.md",
];

const RESEARCH_EXCERPT_CHARS = 1200;

/**
 * Canvas reader. Returns the parsed canvas if the file exists and is
 * shaped right; otherwise returns EMPTY_CANVAS. Never throws -- the
 * step must be tolerant of missing/malformed input because the canvas
 * is founder-edited and we don\'t want to block the summary on a typo.
 */
async function readValidationCanvas(
  fs: Filesystem,
  ventureRoot: string
): Promise<{ canvas: ValidationCanvas; sourcePresent: boolean }> {
  const path = `${getStagePath(ventureRoot, "validation")}/validation-canvas.json`;
  if (!(await fs.exists(path))) {
    return { canvas: { ...EMPTY_CANVAS }, sourcePresent: false };
  }
  try {
    const raw = await fs.readFile(path);
    const parsed = JSON.parse(raw) as Partial<ValidationCanvas>;
    return {
      canvas: {
        ...EMPTY_CANVAS,
        ...parsed,
        experiments: Array.isArray(parsed.experiments)
          ? (parsed.experiments as Experiment[])
          : [],
      },
      sourcePresent: true,
    };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    log.warn(`validation-canvas.json present but unparseable -- using empty defaults: ${m}`);
    return { canvas: { ...EMPTY_CANVAS }, sourcePresent: false };
  }
}

/**
 * Read up to N priority research reports, returning {filename, excerpt}.
 * Truncates each to RESEARCH_EXCERPT_CHARS so the LLM prompt stays
 * bounded. Skipped silently if the file doesn\'t exist.
 */
async function readResearchExcerpts(
  fs: Filesystem,
  ventureRoot: string,
  manifest: VentureManifest
): Promise<{ filename: string; excerpt: string }[]> {
  if (manifest.appType !== "saas") return [];
  const out: { filename: string; excerpt: string }[] = [];
  const baseDir = `${getStagePath(ventureRoot, "research")}/saas`;
  for (const filename of PRIORITY_RESEARCH_REPORTS) {
    const path = `${baseDir}/${filename}`;
    if (!(await fs.exists(path))) continue;
    try {
      const raw = await fs.readFile(path);
      const trimmed = raw.length > RESEARCH_EXCERPT_CHARS
        ? `${raw.slice(0, RESEARCH_EXCERPT_CHARS)}\n\n...[truncated]`
        : raw;
      out.push({ filename, excerpt: trimmed });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to read ${path}: ${m}`);
    }
  }
  return out;
}

/** Compute the ValidationTab must-haves checklist from the canvas. */
function computeMusthaves(canvas: ValidationCanvas): ValidationSummaryJson["musthaves"] {
  const doneExperiments = canvas.experiments.filter(
    (e) => e.status === "done" && e.description.trim().length > 0
  );
  const icpDefined =
    canvas.icpDescription.trim().length >= 30 && canvas.icpPain.trim().length >= 20;
  const offerDefined =
    canvas.valueProposition.trim().length >= 20 && canvas.whatsIncluded.trim().length >= 10;
  const pricingDecided = canvas.pricePoint.trim().length >= 2;
  const experimentRun = doneExperiments.length >= 1;
  const resultsDocumented = canvas.keyLearnings.trim().length >= 30;
  const decisionMade = canvas.validationDecision !== "undecided";
  return {
    icpDefined,
    offerDefined,
    pricingDecided,
    experimentRun,
    resultsDocumented,
    decisionMade,
    allMet:
      icpDefined &&
      offerDefined &&
      pricingDecided &&
      experimentRun &&
      resultsDocumented &&
      decisionMade,
  };
}

/** Tally experiments by status. */
function tallyExperiments(canvas: ValidationCanvas): ValidationSummaryJson["experiments"] {
  let done = 0;
  let running = 0;
  let planned = 0;
  for (const e of canvas.experiments) {
    if (e.status === "done") done += 1;
    else if (e.status === "running") running += 1;
    else if (e.status === "planned") planned += 1;
  }
  return { total: canvas.experiments.length, done, running, planned };
}

/**
 * Build the structured JSON summary. Pure function over the canvas
 * + manifest + sources list -- no IO -- so the runner test can verify
 * shape without a filesystem.
 */
export function buildValidationSummaryJson(args: {
  canvas: ValidationCanvas;
  manifest: VentureManifest;
  runId: string;
  sources: string[];
  summarySource: ValidationSummaryJson["summarySource"];
}): ValidationSummaryJson {
  return {
    schemaVersion: 1,
    stage: "VALIDATION",
    runId: args.runId,
    ventureId: args.manifest.id,
    ventureName: args.manifest.name,
    createdAt: new Date().toISOString(),
    decision: args.canvas.validationDecision,
    decisionReason: args.canvas.decisionReason,
    icp: {
      description: args.canvas.icpDescription,
      role: args.canvas.icpRole,
      pain: args.canvas.icpPain,
    },
    offer: {
      valueProposition: args.canvas.valueProposition,
      whatsIncluded: args.canvas.whatsIncluded,
      whatsExcluded: args.canvas.whatsExcluded,
    },
    pricing: {
      pricePoint: args.canvas.pricePoint,
      pricingModel: args.canvas.pricingModel,
    },
    experiments: tallyExperiments(args.canvas),
    keyLearnings: args.canvas.keyLearnings,
    whatChanged: args.canvas.whatChanged,
    musthaves: computeMusthaves(args.canvas),
    sources: args.sources,
    summarySource: args.summarySource,
  };
}

const DECISION_BANNER: Record<ValidationDecision, string> = {
  validated: "**Decision: Validated** -- customers confirmed they\'d pay.",
  pivot: "**Decision: Pivot** -- the core idea needs adjustment before build.",
  invalidated: "**Decision: Invalidated** -- not worth building as currently scoped.",
  undecided: "**Decision: Undecided** -- still gathering evidence.",
};

/**
 * Deterministic markdown narrative. Used directly when there is no
 * LLM caller, and as a fallback if the LLM call fails. Renders the
 * canvas as readable sections plus a templated go/no-go take that
 * mirrors the ValidationTab UX.
 */
function renderDeterministicMarkdown(
  summary: ValidationSummaryJson,
  manifest: VentureManifest,
  research: { filename: string; excerpt: string }[]
): string {
  const lines: string[] = [];
  lines.push(`# Validation Summary -- ${manifest.name}`);
  lines.push("");
  lines.push(DECISION_BANNER[summary.decision]);
  if (summary.decisionReason.trim().length > 0) {
    lines.push("");
    lines.push(`> ${summary.decisionReason.trim()}`);
  }
  lines.push("");

  lines.push("## ICP");
  lines.push(summary.icp.description.trim() || "_Not yet defined._");
  if (summary.icp.role.trim()) lines.push(`- Role: ${summary.icp.role.trim()}`);
  if (summary.icp.pain.trim()) lines.push(`- Pain: ${summary.icp.pain.trim()}`);
  lines.push("");

  lines.push("## Offer");
  lines.push(summary.offer.valueProposition.trim() || "_Value proposition not yet captured._");
  if (summary.offer.whatsIncluded.trim()) {
    lines.push("");
    lines.push(`**Included (v1):** ${summary.offer.whatsIncluded.trim()}`);
  }
  if (summary.offer.whatsExcluded.trim()) {
    lines.push(`**Excluded (v1):** ${summary.offer.whatsExcluded.trim()}`);
  }
  lines.push("");

  lines.push("## Pricing");
  if (summary.pricing.pricePoint.trim() || summary.pricing.pricingModel.trim()) {
    if (summary.pricing.pricePoint.trim()) {
      lines.push(`- Price point: ${summary.pricing.pricePoint.trim()}`);
    }
    if (summary.pricing.pricingModel.trim()) {
      lines.push(`- Pricing model: ${summary.pricing.pricingModel.trim()}`);
    }
  } else {
    lines.push("_Pricing not yet decided._");
  }
  lines.push("");

  const x = summary.experiments;
  lines.push("## Experiments");
  lines.push(
    `Total: ${x.total} (done: ${x.done}, running: ${x.running}, planned: ${x.planned})`
  );
  lines.push("");

  lines.push("## Key learnings");
  lines.push(summary.keyLearnings.trim() || "_No learnings documented yet._");
  lines.push("");

  if (summary.whatChanged.trim()) {
    lines.push("## What changed");
    lines.push(summary.whatChanged.trim());
    lines.push("");
  }

  lines.push("## Must-haves checklist");
  const m = summary.musthaves;
  const tick = (b: boolean) => (b ? "[x]" : "[ ]");
  lines.push(`- ${tick(m.icpDefined)} ICP fully defined`);
  lines.push(`- ${tick(m.offerDefined)} Offer defined`);
  lines.push(`- ${tick(m.pricingDecided)} Pricing decided`);
  lines.push(`- ${tick(m.experimentRun)} 1+ experiment completed`);
  lines.push(`- ${tick(m.resultsDocumented)} Results documented`);
  lines.push(`- ${tick(m.decisionMade)} Validation decision made`);
  lines.push("");

  lines.push("## Go/no-go take");
  if (summary.decision === "validated" && m.allMet) {
    lines.push(
      "All must-haves are green and the founder has marked the venture validated. Proceed to brand + product stages with confidence."
    );
  } else if (summary.decision === "invalidated") {
    lines.push(
      "The founder has invalidated the current hypothesis. Do not advance to build -- revisit ICP and offer or pause the venture."
    );
  } else if (summary.decision === "pivot") {
    lines.push(
      "A pivot is on the table. Hold downstream stages until the new hypothesis is captured and the canvas updated."
    );
  } else if (!m.allMet) {
    const missing = [
      !m.icpDefined ? "ICP" : null,
      !m.offerDefined ? "offer" : null,
      !m.pricingDecided ? "pricing" : null,
      !m.experimentRun ? "experiment" : null,
      !m.resultsDocumented ? "results" : null,
      !m.decisionMade ? "decision" : null,
    ]
      .filter((s): s is string => s !== null)
      .join(", ");
    lines.push(`Outstanding gaps before this is shippable: ${missing}.`);
  } else {
    lines.push(
      "Must-haves are green but no decision has been recorded. Mark the canvas validated/pivot/invalidated to unblock the next stage."
    );
  }
  lines.push("");

  if (research.length > 0) {
    lines.push("## Research considered");
    for (const r of research) {
      lines.push(`- ${r.filename}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * LLM-enriched narrative. Replaces the deterministic "Go/no-go take"
 * paragraph with a 2-3 paragraph synthesis grounded in the canvas +
 * research excerpts. The structured sections above stay the same so
 * the markdown remains skim-able and predictable.
 */
async function renderLlmMarkdown(args: {
  summary: ValidationSummaryJson;
  manifest: VentureManifest;
  canvas: ValidationCanvas;
  research: { filename: string; excerpt: string }[];
  callLlm: SaasLlmCaller;
}): Promise<{ markdown: string; usedLlm: boolean }> {
  const system = `You are writing the "Go/no-go take" section of a hypothesis-validation summary for the SaaS venture "${args.manifest.name}".

Output rules:
- Output 2-3 short paragraphs of plain prose. No headings, no bullet lists, no markdown code fences.
- Be specific to THIS venture: cite the canvas evidence (decision, ICP pain, pricing, experiments) directly.
- If the canvas is sparse, say what is missing rather than inventing data.
- UK context: GBP for pricing, regulators are Companies House / HMRC / ICO / FCA.
- Roughly 200-350 words. No filler.`;

  const canvasJson = JSON.stringify(
    {
      decision: args.canvas.validationDecision,
      decisionReason: args.canvas.decisionReason,
      icp: {
        description: args.canvas.icpDescription,
        role: args.canvas.icpRole,
        pain: args.canvas.icpPain,
        currentSolution: args.canvas.icpCurrentSolution,
        trigger: args.canvas.icpTrigger,
      },
      offer: {
        valueProposition: args.canvas.valueProposition,
        whatsIncluded: args.canvas.whatsIncluded,
        whatsExcluded: args.canvas.whatsExcluded,
      },
      pricing: {
        pricePoint: args.canvas.pricePoint,
        pricingModel: args.canvas.pricingModel,
        priceSensitivityNotes: args.canvas.priceSensitivityNotes,
      },
      experiments: args.canvas.experiments.map((e) => ({
        status: e.status,
        description: e.description,
      })),
      keyLearnings: args.canvas.keyLearnings,
      whatChanged: args.canvas.whatChanged,
      musthaves: args.summary.musthaves,
    },
    null,
    2
  );

  const researchBlock =
    args.research.length === 0
      ? "No SaaS research reports found under 01_research/saas/. Reason about the venture from the canvas alone and flag the missing research."
      : args.research
          .map((r) => `### ${r.filename}\n\n${r.excerpt}`)
          .join("\n\n");

  const user = `Write the **Go/no-go take** for ${args.manifest.name}.

### Validation canvas

\u0060\u0060\u0060json
${canvasJson}
\u0060\u0060\u0060

### Research excerpts

${researchBlock}`;

  try {
    const narrative = await args.callLlm({ system, user });
    const cleaned = narrative.trim();
    if (!cleaned) throw new Error("LLM returned empty narrative");
    const md = renderDeterministicMarkdown(args.summary, args.manifest, args.research);
    // Replace the deterministic Go/no-go take paragraph with the LLM
    // narrative. The deterministic template always emits a single
    // paragraph after `## Go/no-go take`; we splice that paragraph for
    // the LLM output and keep everything else.
    const replaced = md.replace(
      /## Go\/no-go take\n[^\n]*(\n(?!## )[^\n]*)*/,
      `## Go/no-go take\n${cleaned}`
    );
    return { markdown: replaced, usedLlm: true };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    log.warn(`Validation summary LLM call failed -- using deterministic narrative: ${m}`);
    return {
      markdown: renderDeterministicMarkdown(args.summary, args.manifest, args.research),
      usedLlm: false,
    };
  }
}

/**
 * Produce the validation summary. Always writes both files. Safe to
 * re-run; never touches the canvas.
 */
export async function createValidationSummaryStep(
  ctx: CreateValidationSummaryContext
): Promise<CreateValidationSummaryResult> {
  const stageDir = getStagePath(ctx.ventureRoot, "validation");
  await ctx.fs.mkdir(stageDir);

  const { canvas, sourcePresent } = await readValidationCanvas(ctx.fs, ctx.ventureRoot);
  const research = [
    ...(await readResearchExcerpts(ctx.fs, ctx.ventureRoot, ctx.manifest)),
    ...(ctx.deepResearch ?? []),
  ];

  const sources: string[] = [];
  if (sourcePresent) sources.push("validation-canvas.json");
  for (const r of research) sources.push(r.filename);

  const runId = ctx.runId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Build the structured JSON FIRST -- it never depends on LLM output.
  const summaryDeterministic = buildValidationSummaryJson({
    canvas,
    manifest: ctx.manifest,
    runId,
    sources,
    summarySource: ctx.callLlm ? "llm" : "deterministic",
  });

  let markdown: string;
  let summarySource: ValidationSummaryJson["summarySource"];
  if (ctx.callLlm) {
    const out = await renderLlmMarkdown({
      summary: summaryDeterministic,
      manifest: ctx.manifest,
      canvas,
      research,
      callLlm: ctx.callLlm,
    });
    markdown = out.markdown;
    summarySource = out.usedLlm ? "llm" : "deterministic-fallback";
  } else {
    markdown = renderDeterministicMarkdown(summaryDeterministic, ctx.manifest, research);
    summarySource = "deterministic";
  }
  // Reflect what actually happened in the JSON.
  const summary: ValidationSummaryJson = { ...summaryDeterministic, summarySource };

  const jsonPath = `${stageDir}/validation-summary.json`;
  const mdPath = `${stageDir}/validation-summary.md`;
  await ctx.fs.writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
  await ctx.fs.writeFile(mdPath, markdown.endsWith("\n") ? markdown : `${markdown}\n`);

  log.info(
    `Validation summary written (decision: ${summary.decision}, summarySource: ${summary.summarySource})`
  );
  return { status: "done", jsonPath, mdPath, summary };
}
