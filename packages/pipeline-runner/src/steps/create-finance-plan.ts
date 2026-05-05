/**
 * Finance plan step -- builds a forecast (cost model, revenue
 * assumption, runway, funding recommendation) on top of the founder-
 * editable finance canvas. Combines the manifest, validation summary,
 * and UK setup canvas into a stable plan contract that downstream
 * stages and the desktop UI can read.
 *
 * Inputs
 * ------
 *  - `manifest`       venture.yaml -- entityType, takesPayments,
 *                     regulated, handlesPersonalData, hiresStaff,
 *                     monthlyBudgetCapGBP
 *  - `ventureRoot`    absolute venture folder
 *  - `callLlm`        optional SaaS-style caller. When provided, the
 *                     "Strategic narrative" markdown section is LLM-
 *                     written from the structured plan + assumptions;
 *                     otherwise a deterministic templated narrative
 *                     is rendered.
 *  - `fs`             injected Filesystem
 *
 * Reads (all best-effort)
 * -----------------------
 *  - `05_finance/finance-canvas.json` -- founder-editable canvas
 *    (skip-if-exists; scaffolded with defaults if missing)
 *  - `02_validation/validation-summary.json` -- pricing + decision
 *    feed into the revenue assumption
 *  - `04_uk_business/uk-setup.json` -- UK entity / banking / VAT
 *    nuance (used for assumption strings, not numerical inputs yet)
 *
 * Outputs (under 05_finance/)
 * ---------------------------
 *  - `finance-canvas.json`  -- founder-editable canvas (skip-if-exists)
 *  - `finance-plan.json`    -- structured FinancePlanJson (always
 *                              overwritten; founder edits go in the
 *                              canvas, never here)
 *  - `finance-plan.md`      -- founder-facing readout
 *
 * Behaviour
 * ---------
 *  - Canvas is the founder\'s editable source of truth. We never
 *    overwrite a canvas that already exists -- if a founder has
 *    filled in `monthlyBudgetCapGBP` or pricing tiers, those
 *    persist across runs.
 *  - Plan is always overwritten with the latest computed forecast.
 *  - LLM failures are non-fatal: deterministic narrative is used as
 *    a fallback and `generationSource` flips to
 *    "deterministic-fallback".
 *  - All numbers are GBP. Sensible UK defaults (£1,500/month budget,
 *    3% payment processing, £200 compliance overhead if regulated).
 *
 * Schemas are shape-stable (schemaVersion: 1). Adding fields is fine;
 * renaming/removing breaks downstream and bumps the schema version.
 */
import type { VentureManifest } from "@founder-os/domain";
import { createLogger } from "@founder-os/logger";
import { getStagePath } from "@founder-os/workspace-core";
import type { Filesystem } from "../fs.js";
import type { SaasLlmCaller } from "./create-saas-research-reports.js";

const log = createLogger("pipeline-runner:create-finance-plan");

// ---------------------------------------------------------------------------
// On-disk shapes
// ---------------------------------------------------------------------------

/**
 * Founder-editable canvas at 05_finance/finance-canvas.json.
 *
 * Schema-light intentionally -- the founder edits this via the
 * (forthcoming) FinanceTab. We scaffold defaults if the file is
 * missing; if it exists we leave it alone (skip-if-exists), even if
 * the shape has drifted from this type. The plan reads from the
 * canvas where present and falls back to defaults otherwise.
 *
 * `status: "checkpoint"` is preserved from the legacy skeletal
 * placeholder so consumers reading the field don\'t break.
 */
export type FinanceCanvasJson = {
  schemaVersion: 1;
  stage: "FINANCE";
  status: "checkpoint";
  runId: string;
  ventureId: string;
  createdAt: string;
  /** Founder-editable cap on monthly burn. Null if not yet set. */
  monthlyBudgetCapGBP: number | null;
  /** Founder-editable starting capital (cash on hand). Null if unknown. */
  startingCapitalGBP: number | null;
  revenueModel: string | null;
  pricingTiers: Array<Record<string, unknown>>;
  costProjections: Record<string, unknown> | null;
  runwayMonths: number | null;
  note: string;
};

/** Stable schema for the computed forecast. Always overwritten. */
export type FinancePlanJson = {
  schemaVersion: 1;
  stage: "FINANCE";
  runId: string;
  ventureId: string;
  ventureName: string;
  createdAt: string;
  inputs: {
    monthlyBudgetCapGBP: number | null;
    startingCapitalGBP: number | null;
    entityType: string | null;
    takesPayments: boolean;
    regulated: boolean;
    handlesPersonalData: boolean;
    hiresStaff: boolean;
    pricePoint: string | null;
    pricingModel: string | null;
    validationDecision: string | null;
  };
  monthlyCosts: {
    infrastructureGBP: number;
    paymentProcessingGBP: number;
    complianceGBP: number;
    staffingGBP: number;
    otherGBP: number;
    totalGBP: number;
  };
  revenueAssumption: {
    monthlyPricePerCustomerGBP: number | null;
    targetCustomers12m: number;
    projectedMrr12mGBP: number | null;
    rampMonths: number;
  };
  runway: {
    months: number | null;
    breakEvenCustomers: number | null;
  };
  fundingRecommendation: {
    path: "bootstrap" | "seed" | "unclear";
    rationale: string;
  };
  assumptions: string[];
  sources: string[];
  generationSource: "llm" | "deterministic-fallback" | "deterministic";
};

export type CreateFinancePlanContext = {
  fs: Filesystem;
  manifest: VentureManifest;
  ventureRoot: string;
  callLlm?: SaasLlmCaller;
  runId?: string;
};

export type CreateFinancePlanResult = {
  status: "done";
  /** "scaffolded" if the canvas was freshly written, "preserved" if it already existed. */
  canvasStatus: "scaffolded" | "preserved";
  canvasPath: string;
  planJsonPath: string;
  planMdPath: string;
  canvas: FinanceCanvasJson;
  plan: FinancePlanJson;
};

// ---------------------------------------------------------------------------
// Constants (sensible UK defaults)
// ---------------------------------------------------------------------------

const DEFAULT_MONTHLY_BUDGET_CAP_GBP = 1500;
/** Baseline infrastructure: hosting, domain, transactional email, etc. */
const BASELINE_INFRASTRUCTURE_GBP = 100;
/** Stripe / GoCardless effective rate when takesPayments. */
const PAYMENT_PROCESSING_FRACTION = 0.03;
/** Per-month compliance overhead when handlesPersonalData (ICO + tooling). */
const PERSONAL_DATA_COMPLIANCE_GBP = 50;
/** Per-month compliance overhead when regulated (FCA / sector-specific). */
const REGULATED_COMPLIANCE_GBP = 200;
/** Per-month staffing line when hiresStaff is true (placeholder for one PT contractor). */
const HIRES_STAFF_BASELINE_GBP = 600;
/** Months of ramp before hitting target customers12m. */
const DEFAULT_RAMP_MONTHS = 6;
/** Optimistic-but-grounded baseline for paying customers in month 12. */
const DEFAULT_TARGET_CUSTOMERS_12M = 50;

// ---------------------------------------------------------------------------
// Validation summary + UK setup readers (best-effort, never throw)
// ---------------------------------------------------------------------------

type ValidationSummarySnippet = {
  decision: string;
  pricePoint: string;
  pricingModel: string;
  hasFile: boolean;
};

async function readValidationSummary(
  fs: Filesystem,
  ventureRoot: string
): Promise<ValidationSummarySnippet> {
  const path = `${getStagePath(ventureRoot, "validation")}/validation-summary.json`;
  if (!(await fs.exists(path))) {
    return { decision: "", pricePoint: "", pricingModel: "", hasFile: false };
  }
  try {
    const raw = await fs.readFile(path);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const decision = typeof parsed.decision === "string" ? parsed.decision : "";
    const pricing = (parsed.pricing as Record<string, unknown> | undefined) ?? {};
    const pricePoint = typeof pricing.pricePoint === "string" ? pricing.pricePoint : "";
    const pricingModel = typeof pricing.pricingModel === "string" ? pricing.pricingModel : "";
    return { decision, pricePoint, pricingModel, hasFile: true };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    log.warn(`validation-summary.json present but unparseable -- ignoring: ${m}`);
    return { decision: "", pricePoint: "", pricingModel: "", hasFile: false };
  }
}

type UkSetupSnippet = {
  entityType: string | null;
  hasFile: boolean;
};

async function readUkSetupSnippet(
  fs: Filesystem,
  ventureRoot: string,
  manifest: VentureManifest
): Promise<UkSetupSnippet> {
  const path = `${getStagePath(ventureRoot, "uk")}/uk-setup.json`;
  if (!(await fs.exists(path))) {
    return { entityType: manifest.entityType, hasFile: false };
  }
  try {
    const raw = await fs.readFile(path);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entityType =
      typeof parsed.entityType === "string" ? parsed.entityType : manifest.entityType;
    return { entityType, hasFile: true };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    log.warn(`uk-setup.json present but unparseable -- using manifest default: ${m}`);
    return { entityType: manifest.entityType, hasFile: false };
  }
}

// ---------------------------------------------------------------------------
// Canvas scaffolding
// ---------------------------------------------------------------------------

function buildScaffoldCanvas(args: {
  manifest: VentureManifest;
  runId: string;
}): FinanceCanvasJson {
  const cap = args.manifest.monthlyBudgetCapGBP ?? null;
  return {
    schemaVersion: 1,
    stage: "FINANCE",
    status: "checkpoint",
    runId: args.runId,
    ventureId: args.manifest.id,
    createdAt: new Date().toISOString(),
    monthlyBudgetCapGBP: cap,
    startingCapitalGBP: null,
    revenueModel: null,
    pricingTiers: [],
    costProjections: null,
    runwayMonths: null,
    note: "Founder-editable finance canvas. The plan in finance-plan.{md,json} is regenerated each run; this canvas is the persistent source of truth for founder edits.",
  };
}

/**
 * Read the canvas (skip-if-exists). Returns the parsed canvas when
 * possible, otherwise scaffolds fresh defaults. Never overwrites an
 * existing canvas, even if it fails to parse -- the founder may have
 * extended the shape, and we don\'t want to nuke their work.
 */
async function readOrScaffoldCanvas(args: {
  fs: Filesystem;
  manifest: VentureManifest;
  ventureRoot: string;
  runId: string;
}): Promise<{ canvas: FinanceCanvasJson; status: "scaffolded" | "preserved" }> {
  const dir = getStagePath(args.ventureRoot, "finance");
  await args.fs.mkdir(dir);
  const path = `${dir}/finance-canvas.json`;

  if (await args.fs.exists(path)) {
    try {
      const raw = await args.fs.readFile(path);
      const parsed = JSON.parse(raw) as Partial<FinanceCanvasJson>;
      // Coerce to FinanceCanvasJson with safe defaults; preserves
      // founder-extended fields via spread.
      const scaffold = buildScaffoldCanvas({ manifest: args.manifest, runId: args.runId });
      const merged: FinanceCanvasJson = {
        ...scaffold,
        ...parsed,
        // `stage` and `status` are sticky markers; never let the
        // founder accidentally rename them.
        stage: "FINANCE",
        status: "checkpoint",
        schemaVersion: 1,
      };
      return { canvas: merged, status: "preserved" };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      log.warn(
        `finance-canvas.json present but unparseable -- leaving on disk, using fresh defaults: ${m}`
      );
      return {
        canvas: buildScaffoldCanvas({ manifest: args.manifest, runId: args.runId }),
        status: "preserved",
      };
    }
  }

  const fresh = buildScaffoldCanvas({ manifest: args.manifest, runId: args.runId });
  await args.fs.writeFile(path, `${JSON.stringify(fresh, null, 2)}\n`);
  return { canvas: fresh, status: "scaffolded" };
}

// ---------------------------------------------------------------------------
// Plan computation
// ---------------------------------------------------------------------------

/**
 * Parse a price-point string like "£29", "29.99 GBP", "$29/mo" into
 * a number. Returns null on miss. Heuristic; the founder can refine
 * the canvas to lock in a number.
 */
export function parsePricePointGBP(s: string): number | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  // Match the first numeric span.
  const match = /[0-9]+(?:\.[0-9]+)?/.exec(trimmed);
  if (!match) return null;
  const n = Number.parseFloat(match[0]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function computeMonthlyCosts(args: {
  manifest: VentureManifest;
  monthlyRevenueGBP: number;
}): FinancePlanJson["monthlyCosts"] {
  const infrastructureGBP = BASELINE_INFRASTRUCTURE_GBP;
  const paymentProcessingGBP = args.manifest.takesPayments
    ? Math.round(args.monthlyRevenueGBP * PAYMENT_PROCESSING_FRACTION * 100) / 100
    : 0;
  let complianceGBP = 0;
  if (args.manifest.handlesPersonalData) complianceGBP += PERSONAL_DATA_COMPLIANCE_GBP;
  if (args.manifest.regulated) complianceGBP += REGULATED_COMPLIANCE_GBP;
  const staffingGBP = args.manifest.hiresStaff ? HIRES_STAFF_BASELINE_GBP : 0;
  const otherGBP = 0;
  const totalGBP =
    infrastructureGBP + paymentProcessingGBP + complianceGBP + staffingGBP + otherGBP;
  return {
    infrastructureGBP,
    paymentProcessingGBP,
    complianceGBP,
    staffingGBP,
    otherGBP,
    totalGBP: Math.round(totalGBP * 100) / 100,
  };
}

export function computeRevenueAssumption(args: {
  pricePoint: string;
  pricingModel: string;
  rampMonths?: number;
}): FinancePlanJson["revenueAssumption"] {
  const monthlyPricePerCustomerGBP = parsePricePointGBP(args.pricePoint);
  const targetCustomers12m = DEFAULT_TARGET_CUSTOMERS_12M;
  const projectedMrr12mGBP =
    monthlyPricePerCustomerGBP === null
      ? null
      : Math.round(monthlyPricePerCustomerGBP * targetCustomers12m * 100) / 100;
  return {
    monthlyPricePerCustomerGBP,
    targetCustomers12m,
    projectedMrr12mGBP,
    rampMonths: args.rampMonths ?? DEFAULT_RAMP_MONTHS,
  };
}

export function computeRunway(args: {
  startingCapitalGBP: number | null;
  monthlyBudgetCapGBP: number | null;
  monthlyCostsTotalGBP: number;
  monthlyPricePerCustomerGBP: number | null;
}): FinancePlanJson["runway"] {
  const cap = args.startingCapitalGBP ?? args.monthlyBudgetCapGBP;
  let months: number | null = null;
  if (cap !== null && args.monthlyCostsTotalGBP > 0) {
    if (args.startingCapitalGBP !== null) {
      // Treat starting capital as a pool. Months = capital / monthly costs.
      months = Math.floor(args.startingCapitalGBP / args.monthlyCostsTotalGBP);
    } else if (args.monthlyBudgetCapGBP !== null) {
      // Treat the cap as a monthly ceiling. If costs <= cap, runway is
      // unbounded by burn; we surface a 12-month sanity number instead.
      months = args.monthlyCostsTotalGBP <= args.monthlyBudgetCapGBP ? 12 : 0;
    }
  }
  let breakEvenCustomers: number | null = null;
  if (
    args.monthlyPricePerCustomerGBP !== null &&
    args.monthlyPricePerCustomerGBP > 0 &&
    args.monthlyCostsTotalGBP > 0
  ) {
    breakEvenCustomers = Math.ceil(
      args.monthlyCostsTotalGBP / args.monthlyPricePerCustomerGBP
    );
  }
  return { months, breakEvenCustomers };
}

export function recommendFundingPath(args: {
  monthlyCostsTotalGBP: number;
  validationDecision: string;
  hasValidation: boolean;
}): FinancePlanJson["fundingRecommendation"] {
  if (!args.hasValidation) {
    return {
      path: "unclear",
      rationale:
        "No validation summary available yet -- complete the VALIDATION stage to ground the funding recommendation in real evidence.",
    };
  }
  if (args.validationDecision === "invalidated") {
    return {
      path: "unclear",
      rationale:
        "Validation marked the hypothesis invalidated. Pause finance planning until the canvas is re-pointed at a viable hypothesis.",
    };
  }
  if (args.monthlyCostsTotalGBP <= 2000) {
    return {
      path: "bootstrap",
      rationale:
        "Monthly burn fits inside a sensible bootstrap budget (<= GBP 2,000). Plan for self-funding through the ramp; revisit if usage drives infrastructure cost beyond the cap.",
    };
  }
  return {
    path: "seed",
    rationale:
      "Monthly burn exceeds the bootstrap threshold (> GBP 2,000). Build a 12-18 month plan and consider a friends-and-family or pre-seed round once validation evidence + traction are on the canvas.",
  };
}

function buildAssumptions(args: {
  manifest: VentureManifest;
  pricePointParsed: number | null;
  validation: ValidationSummarySnippet;
  uk: UkSetupSnippet;
}): string[] {
  const out: string[] = [];
  out.push(`Currency: GBP. Defaults follow UK SaaS norms.`);
  out.push(
    `Infrastructure baseline GBP ${BASELINE_INFRASTRUCTURE_GBP}/month covers hosting, domain, transactional email, and basic monitoring.`
  );
  if (args.manifest.takesPayments) {
    out.push(
      `Payment processing modelled at ${(PAYMENT_PROCESSING_FRACTION * 100).toFixed(1)}% of monthly revenue (Stripe / GoCardless effective).`
    );
  } else {
    out.push("takesPayments=false -> no payment processing line.");
  }
  if (args.manifest.handlesPersonalData) {
    out.push(
      `handlesPersonalData=true -> GBP ${PERSONAL_DATA_COMPLIANCE_GBP}/month compliance line (ICO registration + tooling).`
    );
  }
  if (args.manifest.regulated) {
    out.push(
      `regulated=true -> GBP ${REGULATED_COMPLIANCE_GBP}/month compliance overhead (sector-specific, refine via UK setup).`
    );
  }
  if (args.manifest.hiresStaff) {
    out.push(
      `hiresStaff=true -> GBP ${HIRES_STAFF_BASELINE_GBP}/month staffing baseline (placeholder for one part-time contractor).`
    );
  } else {
    out.push("hiresStaff=false -> founder time is unpriced in this plan.");
  }
  if (args.pricePointParsed !== null) {
    out.push(
      `Price point parsed as GBP ${args.pricePointParsed}/customer/month from validation canvas.`
    );
  } else if (args.validation.hasFile) {
    out.push(
      "Price point on the validation canvas was not numeric -- MRR cannot be projected. Update the canvas with a concrete price."
    );
  } else {
    out.push(
      "No validation summary found. Complete the VALIDATION stage to seed pricing into this plan."
    );
  }
  out.push(`Ramp: ${DEFAULT_RAMP_MONTHS} months to ${DEFAULT_TARGET_CUSTOMERS_12M} customers.`);
  if (args.uk.entityType) {
    out.push(`Entity: ${args.uk.entityType} (from ${args.uk.hasFile ? "uk-setup.json" : "manifest"}).`);
  }
  out.push(
    `Budget cap: GBP ${args.manifest.monthlyBudgetCapGBP ?? DEFAULT_MONTHLY_BUDGET_CAP_GBP}/month (from manifest, fallback ${DEFAULT_MONTHLY_BUDGET_CAP_GBP}).`
  );
  return out;
}

// ---------------------------------------------------------------------------
// LLM enrichment (strategic narrative)
// ---------------------------------------------------------------------------

const NARRATIVE_SYSTEM = `You are writing the "Strategic narrative" section of a SaaS finance plan for the venture below.

Output rules:
- 2-3 short paragraphs of plain prose. NO headings, NO bullet lists, NO markdown code fences.
- Cover, in this order: what the cost / runway / break-even numbers actually mean for the founder; the most important risk or sensitivity given the validation evidence; one concrete next step (cut a cost line, revise the price, run a specific experiment).
- Be specific to this venture\'s flags (regulated / takesPayments / handlesPersonalData / hiresStaff) and the validation decision.
- UK context: GBP, Companies House / HMRC / ICO / FCA where relevant.
- Roughly 180-300 words. No filler.`;

function buildNarrativeUserPrompt(args: {
  manifest: VentureManifest;
  plan: FinancePlanJson;
}): string {
  return `Write the **Strategic narrative** for the SaaS venture "${args.manifest.name}".

Plan snapshot (JSON):

${JSON.stringify(
  {
    inputs: args.plan.inputs,
    monthlyCosts: args.plan.monthlyCosts,
    revenueAssumption: args.plan.revenueAssumption,
    runway: args.plan.runway,
    fundingRecommendation: args.plan.fundingRecommendation,
    assumptions: args.plan.assumptions,
  },
  null,
  2
)}`;
}

async function enrichNarrative(args: {
  manifest: VentureManifest;
  plan: FinancePlanJson;
  callLlm: SaasLlmCaller;
}): Promise<{ narrative: string; usedLlm: boolean }> {
  try {
    const text = await args.callLlm({
      system: NARRATIVE_SYSTEM,
      user: buildNarrativeUserPrompt({ manifest: args.manifest, plan: args.plan }),
    });
    const cleaned = text.trim();
    if (!cleaned) throw new Error("LLM returned empty narrative");
    return { narrative: cleaned, usedLlm: true };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    log.warn(`Finance LLM enrichment failed -- using deterministic narrative: ${m}`);
    return { narrative: deterministicNarrative(args.plan), usedLlm: false };
  }
}

function deterministicNarrative(plan: FinancePlanJson): string {
  const c = plan.monthlyCosts;
  const r = plan.runway;
  const f = plan.fundingRecommendation;
  const parts: string[] = [];
  parts.push(
    `Monthly burn lands at about GBP ${c.totalGBP}, dominated by ${describeCostDriver(c)}. ${r.months !== null ? `That gives a runway of ~${r.months} months at the current cap.` : "Capital input is unknown -- runway cannot be projected without a starting balance."}`
  );
  if (r.breakEvenCustomers !== null) {
    parts.push(
      `Break-even at the current price needs about ${r.breakEvenCustomers} paying customers. Set that as the leading metric for the first ${plan.revenueAssumption.rampMonths} months.`
    );
  } else {
    parts.push(
      "Break-even cannot be computed yet -- the validation canvas does not have a numeric price. Add one to unlock the model."
    );
  }
  parts.push(`Funding recommendation: ${f.path}. ${f.rationale}`);
  return parts.join(" ");
}

function describeCostDriver(c: FinancePlanJson["monthlyCosts"]): string {
  const lines: { label: string; value: number }[] = [
    { label: "infrastructure", value: c.infrastructureGBP },
    { label: "compliance", value: c.complianceGBP },
    { label: "staffing", value: c.staffingGBP },
    { label: "payment processing", value: c.paymentProcessingGBP },
    { label: "other", value: c.otherGBP },
  ];
  lines.sort((a, b) => b.value - a.value);
  const top = lines[0];
  if (!top || top.value === 0) return "no cost line yet (founder time unpriced)";
  return `${top.label} (GBP ${top.value})`;
}

// ---------------------------------------------------------------------------
// Markdown render
// ---------------------------------------------------------------------------

function renderPlanMarkdown(args: {
  manifest: VentureManifest;
  plan: FinancePlanJson;
  narrative: string;
}): string {
  const lines: string[] = [];
  lines.push(`# Finance plan -- ${args.manifest.name}`);
  lines.push("");
  lines.push(
    `Computed forecast. Re-runs overwrite this file with the latest inputs from the canvas + manifest + validation summary.`
  );
  lines.push("");

  const c = args.plan.monthlyCosts;
  lines.push("## Monthly costs (GBP)");
  lines.push("");
  lines.push("| Line | Amount |");
  lines.push("| --- | ---: |");
  lines.push(`| Infrastructure | ${c.infrastructureGBP.toFixed(2)} |`);
  lines.push(`| Payment processing | ${c.paymentProcessingGBP.toFixed(2)} |`);
  lines.push(`| Compliance | ${c.complianceGBP.toFixed(2)} |`);
  lines.push(`| Staffing | ${c.staffingGBP.toFixed(2)} |`);
  lines.push(`| Other | ${c.otherGBP.toFixed(2)} |`);
  lines.push(`| **Total** | **${c.totalGBP.toFixed(2)}** |`);
  lines.push("");

  const r = args.plan.revenueAssumption;
  lines.push("## Revenue assumption");
  lines.push("");
  lines.push(
    `- Price per customer / month: ${r.monthlyPricePerCustomerGBP === null ? "_unset (set on validation canvas)_" : `GBP ${r.monthlyPricePerCustomerGBP.toFixed(2)}`}`
  );
  lines.push(`- Target customers (month 12): ${r.targetCustomers12m}`);
  lines.push(
    `- Projected MRR (month 12): ${r.projectedMrr12mGBP === null ? "_unset_" : `GBP ${r.projectedMrr12mGBP.toFixed(2)}`}`
  );
  lines.push(`- Ramp: ${r.rampMonths} months`);
  lines.push("");

  const rw = args.plan.runway;
  lines.push("## Runway + break-even");
  lines.push("");
  lines.push(
    `- Runway: ${rw.months === null ? "_unknown (no capital input)_" : `${rw.months} months`}`
  );
  lines.push(
    `- Break-even customers: ${rw.breakEvenCustomers === null ? "_unset_" : `${rw.breakEvenCustomers}`}`
  );
  lines.push("");

  const fr = args.plan.fundingRecommendation;
  lines.push("## Funding recommendation");
  lines.push("");
  lines.push(`**Path: ${fr.path}**`);
  lines.push("");
  lines.push(fr.rationale);
  lines.push("");

  lines.push("## Strategic narrative");
  lines.push("");
  lines.push(args.narrative);
  lines.push("");

  lines.push("## Assumptions");
  for (const a of args.plan.assumptions) {
    lines.push(`- ${a}`);
  }
  lines.push("");

  lines.push(
    `_Generation source: ${args.plan.generationSource}. Re-run with a configured LLM provider for richer narratives._`
  );
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main step
// ---------------------------------------------------------------------------

export async function createFinancePlanStep(
  ctx: CreateFinancePlanContext
): Promise<CreateFinancePlanResult> {
  const dir = getStagePath(ctx.ventureRoot, "finance");
  await ctx.fs.mkdir(dir);

  const runId = ctx.runId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const { canvas, status: canvasStatus } = await readOrScaffoldCanvas({
    fs: ctx.fs,
    manifest: ctx.manifest,
    ventureRoot: ctx.ventureRoot,
    runId,
  });

  const validation = await readValidationSummary(ctx.fs, ctx.ventureRoot);
  const uk = await readUkSetupSnippet(ctx.fs, ctx.ventureRoot, ctx.manifest);

  const sources: string[] = ["finance-canvas.json"];
  if (validation.hasFile) sources.push("validation-summary.json");
  if (uk.hasFile) sources.push("uk-setup.json");

  const pricePointParsed = parsePricePointGBP(validation.pricePoint);
  const revenueAssumption = computeRevenueAssumption({
    pricePoint: validation.pricePoint,
    pricingModel: validation.pricingModel,
  });
  // Use projected month-12 MRR as the revenue input for cost
  // calculation -- payment processing is roughly proportional to
  // revenue and we want the cost line to reflect a steady-state
  // assumption rather than zero.
  const monthlyRevenueForCosting = revenueAssumption.projectedMrr12mGBP ?? 0;
  const monthlyCosts = computeMonthlyCosts({
    manifest: ctx.manifest,
    monthlyRevenueGBP: monthlyRevenueForCosting,
  });
  const runway = computeRunway({
    startingCapitalGBP: canvas.startingCapitalGBP,
    monthlyBudgetCapGBP: canvas.monthlyBudgetCapGBP ?? ctx.manifest.monthlyBudgetCapGBP ?? null,
    monthlyCostsTotalGBP: monthlyCosts.totalGBP,
    monthlyPricePerCustomerGBP: revenueAssumption.monthlyPricePerCustomerGBP,
  });
  const fundingRecommendation = recommendFundingPath({
    monthlyCostsTotalGBP: monthlyCosts.totalGBP,
    validationDecision: validation.decision,
    hasValidation: validation.hasFile,
  });
  const assumptions = buildAssumptions({
    manifest: ctx.manifest,
    pricePointParsed,
    validation,
    uk,
  });

  const planNoNarrative: FinancePlanJson = {
    schemaVersion: 1,
    stage: "FINANCE",
    runId,
    ventureId: ctx.manifest.id,
    ventureName: ctx.manifest.name,
    createdAt: new Date().toISOString(),
    inputs: {
      monthlyBudgetCapGBP:
        canvas.monthlyBudgetCapGBP ?? ctx.manifest.monthlyBudgetCapGBP ?? null,
      startingCapitalGBP: canvas.startingCapitalGBP,
      entityType: uk.entityType,
      takesPayments: ctx.manifest.takesPayments,
      regulated: ctx.manifest.regulated,
      handlesPersonalData: ctx.manifest.handlesPersonalData,
      hiresStaff: ctx.manifest.hiresStaff,
      pricePoint: validation.pricePoint || null,
      pricingModel: validation.pricingModel || null,
      validationDecision: validation.hasFile ? validation.decision : null,
    },
    monthlyCosts,
    revenueAssumption,
    runway,
    fundingRecommendation,
    assumptions,
    sources,
    generationSource: "deterministic",
  };

  let narrative: string;
  let generationSource: FinancePlanJson["generationSource"];
  if (ctx.callLlm) {
    const out = await enrichNarrative({
      manifest: ctx.manifest,
      plan: planNoNarrative,
      callLlm: ctx.callLlm,
    });
    narrative = out.narrative;
    generationSource = out.usedLlm ? "llm" : "deterministic-fallback";
  } else {
    narrative = deterministicNarrative(planNoNarrative);
    generationSource = "deterministic";
  }

  const plan: FinancePlanJson = { ...planNoNarrative, generationSource };

  const canvasPath = `${dir}/finance-canvas.json`;
  const planJsonPath = `${dir}/finance-plan.json`;
  const planMdPath = `${dir}/finance-plan.md`;

  await ctx.fs.writeFile(planJsonPath, `${JSON.stringify(plan, null, 2)}\n`);
  const md = renderPlanMarkdown({ manifest: ctx.manifest, plan, narrative });
  await ctx.fs.writeFile(planMdPath, md.endsWith("\n") ? md : `${md}\n`);

  log.info(
    `Finance plan written (canvas: ${canvasStatus}, monthlyCostsGBP: ${monthlyCosts.totalGBP}, fundingPath: ${fundingRecommendation.path}, generationSource: ${generationSource})`
  );

  return {
    status: "done",
    canvasStatus,
    canvasPath,
    planJsonPath,
    planMdPath,
    canvas,
    plan,
  };
}
