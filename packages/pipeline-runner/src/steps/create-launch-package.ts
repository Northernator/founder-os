/**
 * Launch package step -- synthesises every upstream artifact into a
 * launch receipt + founder-facing announcement copy. Terminal step
 * for the venture pipeline.
 *
 * Inputs
 * ------
 *  - `manifest`       venture.yaml (id/name/slug)
 *  - `ventureRoot`    absolute venture folder
 *  - `callLlm`        optional SaaS-style caller. When provided the
 *                     announcement markdown is LLM-written from the
 *                     receipt + brand brief; otherwise a deterministic
 *                     templated announcement is rendered.
 *  - `fs`             injected Filesystem
 *
 * Reads (all best-effort, never throw)
 * ------------------------------------
 *  - `03_brand/brand-kit/brand-brief.json` -- name, tagline, mission,
 *    targetAudience, palette
 *  - `02_validation/validation-summary.json` -- decision, ICP, pricing
 *  - `05_finance/finance-plan.json` -- pricing, fundingRecommendation
 *  - `04_uk_business/uk-setup.json` -- entityType
 *  - `07_build/build-handoff.json` (best-effort -- shape varies)
 *  - `handoffs/inbox/*` (sentinel that build handoff has been emitted)
 *
 * Outputs (under 08_launch/)
 * --------------------------
 *  - `launch-receipt.json`     -- structured LaunchReceiptJson
 *  - `launch-announcement.md`  -- founder-facing announcement copy
 *
 * Behaviour
 * ---------
 *  - Re-running overwrites both files with the latest receipt
 *    state. There\'s no founder-editable launch canvas (yet); the
 *    upstream artifacts are the source of truth.
 *  - LLM failures are non-fatal: deterministic announcement is used
 *    as a fallback and `generationSource` flips to
 *    "deterministic-fallback".
 *  - Pre-launch checklist is computed deterministically from the
 *    presence + content of upstream artifacts. Any "fail" item makes
 *    the receipt status `"needs-attention"`; any "warn" without a
 *    "fail" -> `"checkpoint"`; all "pass" -> `"ready-to-launch"`.
 *
 * Schema is shape-stable (schemaVersion: 1). Adding fields is fine;
 * renaming/removing breaks downstream and bumps the schema version.
 */
import type { VentureManifest } from "@founder-os/domain";
import { createLogger } from "@founder-os/logger";
import { getStagePath } from "@founder-os/workspace-core";
import type { Filesystem } from "../fs.js";
import type { SaasLlmCaller } from "./create-saas-research-reports.js";

const log = createLogger("pipeline-runner:create-launch-package");

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

export type LaunchChecklistItemStatus = "pass" | "warn" | "fail";

export type LaunchChecklistItem = {
  id: string;
  label: string;
  status: LaunchChecklistItemStatus;
  note: string;
};

export type LaunchReceiptStatus = "ready-to-launch" | "checkpoint" | "needs-attention";

export type LaunchReceiptJson = {
  schemaVersion: 1;
  stage: "LAUNCH";
  runId: string;
  ventureId: string;
  ventureName: string;
  ventureSlug: string;
  launchedAt: string;
  /**
   * Status reflects the pre-launch checklist outcome:
   *  - "ready-to-launch" -- all checks pass.
   *  - "checkpoint"      -- non-fatal warnings; founder should review.
   *  - "needs-attention" -- one or more checks failed; do not launch.
   * Kept "checkpoint" as the default to preserve the legacy
   * skeletal-runner contract for consumers that read this field.
   */
  status: LaunchReceiptStatus;
  /** Optional deployment URL -- founder fills this on the build handoff. */
  deploymentUrl: string | null;
  /** Optional version tag -- pulled from build handoff if present. */
  versionTag: string | null;
  buildRunId: string | null;
  brand: {
    name: string | null;
    tagline: string | null;
    targetAudience: string | null;
  };
  validation: {
    decision: string | null;
    icp: string | null;
  };
  pricing: {
    pricePoint: string | null;
    pricingModel: string | null;
    fundingRecommendation: string | null;
  };
  ukSetup: {
    entityType: string | null;
    hasUkSetupCanvas: boolean;
  };
  build: {
    hasHandoff: boolean;
  };
  preLaunchChecklist: LaunchChecklistItem[];
  sources: string[];
  generationSource: "llm" | "deterministic-fallback" | "deterministic";
};

export type CreateLaunchPackageContext = {
  fs: Filesystem;
  manifest: VentureManifest;
  ventureRoot: string;
  callLlm?: SaasLlmCaller;
  runId?: string;
};

export type CreateLaunchPackageResult = {
  status: "done";
  receiptPath: string;
  announcementPath: string;
  receipt: LaunchReceiptJson;
};

// ---------------------------------------------------------------------------
// Upstream readers (best-effort)
// ---------------------------------------------------------------------------

type BrandSnippet = {
  name: string;
  tagline: string;
  mission: string;
  targetAudience: string;
  hasFile: boolean;
};

async function readBrandBrief(
  fs: Filesystem,
  ventureRoot: string
): Promise<BrandSnippet> {
  const path = `${ventureRoot}/03_brand/brand-kit/brand-brief.json`;
  if (!(await fs.exists(path))) {
    return { name: "", tagline: "", mission: "", targetAudience: "", hasFile: false };
  }
  try {
    const raw = await fs.readFile(path);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      name: typeof parsed.name === "string" ? parsed.name : "",
      tagline: typeof parsed.tagline === "string" ? parsed.tagline : "",
      mission: typeof parsed.mission === "string" ? parsed.mission : "",
      targetAudience:
        typeof parsed.targetAudience === "string" ? parsed.targetAudience : "",
      hasFile: true,
    };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    log.warn(`brand-brief.json present but unparseable -- ignoring: ${m}`);
    return { name: "", tagline: "", mission: "", targetAudience: "", hasFile: false };
  }
}

type ValidationSnippet = {
  decision: string;
  icp: string;
  pricePoint: string;
  pricingModel: string;
  hasFile: boolean;
};

async function readValidation(
  fs: Filesystem,
  ventureRoot: string
): Promise<ValidationSnippet> {
  const path = `${getStagePath(ventureRoot, "validation")}/validation-summary.json`;
  if (!(await fs.exists(path))) {
    return { decision: "", icp: "", pricePoint: "", pricingModel: "", hasFile: false };
  }
  try {
    const raw = await fs.readFile(path);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const icp = (parsed.icp as Record<string, unknown> | undefined) ?? {};
    const pricing = (parsed.pricing as Record<string, unknown> | undefined) ?? {};
    return {
      decision: typeof parsed.decision === "string" ? parsed.decision : "",
      icp: typeof icp.description === "string" ? icp.description : "",
      pricePoint: typeof pricing.pricePoint === "string" ? pricing.pricePoint : "",
      pricingModel: typeof pricing.pricingModel === "string" ? pricing.pricingModel : "",
      hasFile: true,
    };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    log.warn(`validation-summary.json present but unparseable: ${m}`);
    return { decision: "", icp: "", pricePoint: "", pricingModel: "", hasFile: false };
  }
}

type FinanceSnippet = {
  fundingPath: string;
  pricePoint: string | null;
  hasFile: boolean;
};

async function readFinance(
  fs: Filesystem,
  ventureRoot: string
): Promise<FinanceSnippet> {
  const path = `${getStagePath(ventureRoot, "finance")}/finance-plan.json`;
  if (!(await fs.exists(path))) {
    return { fundingPath: "", pricePoint: null, hasFile: false };
  }
  try {
    const raw = await fs.readFile(path);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const fr = (parsed.fundingRecommendation as Record<string, unknown> | undefined) ?? {};
    const inputs = (parsed.inputs as Record<string, unknown> | undefined) ?? {};
    return {
      fundingPath: typeof fr.path === "string" ? fr.path : "",
      pricePoint: typeof inputs.pricePoint === "string" ? inputs.pricePoint : null,
      hasFile: true,
    };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    log.warn(`finance-plan.json present but unparseable: ${m}`);
    return { fundingPath: "", pricePoint: null, hasFile: false };
  }
}

type UkSetupSnippet = {
  entityType: string | null;
  hasFile: boolean;
};

async function readUkSetup(
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
    log.warn(`uk-setup.json present but unparseable: ${m}`);
    return { entityType: manifest.entityType, hasFile: false };
  }
}

type BuildSnippet = {
  hasHandoff: boolean;
  deploymentUrl: string | null;
  versionTag: string | null;
  buildRunId: string | null;
};

/**
 * Build handoff lives at `07_build/build-handoff.json` per the
 * audit-venture step\'s expectations. Best-effort -- shape varies and
 * the founder may add custom fields.
 */
async function readBuildHandoff(
  fs: Filesystem,
  ventureRoot: string
): Promise<BuildSnippet> {
  const path = `${getStagePath(ventureRoot, "build")}/build-handoff.json`;
  if (!(await fs.exists(path))) {
    return { hasHandoff: false, deploymentUrl: null, versionTag: null, buildRunId: null };
  }
  try {
    const raw = await fs.readFile(path);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      hasHandoff: true,
      deploymentUrl:
        typeof parsed.deploymentUrl === "string" ? parsed.deploymentUrl : null,
      versionTag: typeof parsed.versionTag === "string" ? parsed.versionTag : null,
      buildRunId:
        typeof parsed.runId === "string"
          ? parsed.runId
          : typeof parsed.buildRunId === "string"
            ? parsed.buildRunId
            : null,
    };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    log.warn(`build-handoff.json present but unparseable: ${m}`);
    return { hasHandoff: false, deploymentUrl: null, versionTag: null, buildRunId: null };
  }
}

// ---------------------------------------------------------------------------
// Pre-launch checklist
// ---------------------------------------------------------------------------

export function buildPreLaunchChecklist(args: {
  brand: BrandSnippet;
  validation: ValidationSnippet;
  finance: FinanceSnippet;
  uk: UkSetupSnippet;
  build: BuildSnippet;
}): LaunchChecklistItem[] {
  const items: LaunchChecklistItem[] = [];

  // Validation: must be "validated"
  if (!args.validation.hasFile) {
    items.push({
      id: "validation.summary",
      label: "Validation summary present",
      status: "fail",
      note: "No validation summary at 02_validation/. Run the VALIDATION stage first.",
    });
  } else if (args.validation.decision === "validated") {
    items.push({
      id: "validation.summary",
      label: "Validation decision",
      status: "pass",
      note: "Founder marked the venture validated.",
    });
  } else if (args.validation.decision === "invalidated") {
    items.push({
      id: "validation.summary",
      label: "Validation decision",
      status: "fail",
      note: "Hypothesis was invalidated -- do not launch as currently scoped.",
    });
  } else if (args.validation.decision === "pivot") {
    items.push({
      id: "validation.summary",
      label: "Validation decision",
      status: "warn",
      note: "Validation flagged a pivot. Confirm the canvas reflects the new hypothesis before launching.",
    });
  } else {
    items.push({
      id: "validation.summary",
      label: "Validation decision",
      status: "warn",
      note: "Decision is undecided. Consider locking it in before launch.",
    });
  }

  // Brand brief
  if (!args.brand.hasFile) {
    items.push({
      id: "brand.brief",
      label: "Brand brief present",
      status: "fail",
      note: "No brand-brief.json. Run the BRAND stage first.",
    });
  } else if (!args.brand.name.trim()) {
    items.push({
      id: "brand.brief",
      label: "Brand name set",
      status: "fail",
      note: "brand-brief.json is missing a `name`. Re-run the BRAND stage.",
    });
  } else {
    items.push({
      id: "brand.brief",
      label: "Brand brief",
      status: "pass",
      note: `"${args.brand.name}" with tagline "${args.brand.tagline || "(no tagline)"}".`,
    });
  }

  // Finance plan
  if (!args.finance.hasFile) {
    items.push({
      id: "finance.plan",
      label: "Finance plan present",
      status: "warn",
      note: "No finance-plan.json. Launching without a runway forecast is risky.",
    });
  } else if (
    args.finance.fundingPath === "unclear" ||
    args.finance.fundingPath === ""
  ) {
    items.push({
      id: "finance.plan",
      label: "Funding path decided",
      status: "warn",
      note: "Finance plan funding recommendation is unclear. Revisit before launch.",
    });
  } else {
    items.push({
      id: "finance.plan",
      label: "Funding path",
      status: "pass",
      note: `Funding path: ${args.finance.fundingPath}.`,
    });
  }

  // UK setup
  if (!args.uk.hasFile) {
    items.push({
      id: "uk.setup",
      label: "UK setup canvas present",
      status: "warn",
      note: "No uk-setup.json. Companies House / HMRC obligations unclear.",
    });
  } else {
    items.push({
      id: "uk.setup",
      label: "UK setup",
      status: "pass",
      note: `Entity: ${args.uk.entityType ?? "unknown"}.`,
    });
  }

  // Build handoff
  if (!args.build.hasHandoff) {
    items.push({
      id: "build.handoff",
      label: "Build handoff present",
      status: "fail",
      note: "No build-handoff.json. Cannot launch without a built artifact.",
    });
  } else {
    items.push({
      id: "build.handoff",
      label: "Build handoff",
      status: "pass",
      note: args.build.deploymentUrl
        ? `Deployed at ${args.build.deploymentUrl}.`
        : "Build artifact present; deploymentUrl not yet recorded.",
    });
  }

  return items;
}

export function deriveReceiptStatus(items: LaunchChecklistItem[]): LaunchReceiptStatus {
  if (items.some((i) => i.status === "fail")) return "needs-attention";
  if (items.some((i) => i.status === "warn")) return "checkpoint";
  return "ready-to-launch";
}

// ---------------------------------------------------------------------------
// Markdown render
// ---------------------------------------------------------------------------

const STATUS_BANNER: Record<LaunchReceiptStatus, string> = {
  "ready-to-launch":
    "**Status: Ready to launch.** All pre-launch checks pass -- ship it.",
  checkpoint:
    "**Status: Checkpoint.** Non-fatal warnings flagged below; review before public launch.",
  "needs-attention":
    "**Status: Needs attention.** One or more pre-launch checks failed -- do not launch yet.",
};

const STATUS_ICON: Record<LaunchChecklistItemStatus, string> = {
  pass: "[x]",
  warn: "[!]",
  fail: "[ ]",
};

function renderDeterministicAnnouncement(args: {
  manifest: VentureManifest;
  receipt: LaunchReceiptJson;
}): string {
  const lines: string[] = [];
  const heroName = args.receipt.brand.name || args.manifest.name;
  const tagline = args.receipt.brand.tagline?.trim();
  lines.push(`# Launching ${heroName}`);
  lines.push("");
  lines.push(STATUS_BANNER[args.receipt.status]);
  lines.push("");
  if (tagline) {
    lines.push(`> ${tagline}`);
    lines.push("");
  }

  lines.push("## What we built");
  lines.push("");
  if (args.receipt.brand.targetAudience) {
    lines.push(`For: ${args.receipt.brand.targetAudience}`);
    lines.push("");
  }
  if (args.receipt.validation.icp) {
    lines.push(`ICP: ${args.receipt.validation.icp}`);
    lines.push("");
  }
  lines.push(
    args.receipt.deploymentUrl
      ? `Live at: ${args.receipt.deploymentUrl}`
      : "_Deployment URL not yet recorded -- update the build handoff once the prod URL is live._"
  );
  if (args.receipt.versionTag) {
    lines.push(`Version: ${args.receipt.versionTag}`);
  }
  lines.push("");

  lines.push("## How it\'s priced");
  lines.push("");
  if (args.receipt.pricing.pricePoint || args.receipt.pricing.pricingModel) {
    if (args.receipt.pricing.pricePoint) {
      lines.push(`- Price: ${args.receipt.pricing.pricePoint}`);
    }
    if (args.receipt.pricing.pricingModel) {
      lines.push(`- Model: ${args.receipt.pricing.pricingModel}`);
    }
    if (args.receipt.pricing.fundingRecommendation) {
      lines.push(`- Funding path: ${args.receipt.pricing.fundingRecommendation}`);
    }
  } else {
    lines.push("_Pricing not yet captured -- complete the validation + finance stages._");
  }
  lines.push("");

  lines.push("## Pre-launch checklist");
  lines.push("");
  for (const item of args.receipt.preLaunchChecklist) {
    lines.push(`- ${STATUS_ICON[item.status]} **${item.label}** -- ${item.note}`);
  }
  lines.push("");

  lines.push("## Post-launch tracking");
  lines.push("");
  lines.push("- Watch error rates and signups in the first 48 hours.");
  lines.push(
    "- Schedule a retro at the end of week 1 against the validation must-haves and finance break-even target."
  );
  if (args.receipt.ukSetup.entityType) {
    lines.push(
      `- Confirm the ${args.receipt.ukSetup.entityType} entity\'s post-launch obligations (HMRC corporation tax / VAT thresholds / ICO renewal).`
    );
  }
  lines.push("");

  lines.push(
    `_Generation source: ${args.receipt.generationSource}. Re-run with a configured LLM provider for a richer announcement._`
  );
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// LLM enrichment (announcement narrative)
// ---------------------------------------------------------------------------

const ANNOUNCEMENT_SYSTEM = `You are writing the founder-facing launch announcement for a SaaS venture.

Output rules:
- Output Markdown. Start with "# Launching <name>", then a one-line status callout matching the receipt status, then sections in this order: "## What we built" (hero copy + target audience), "## How it\'s priced" (price + model + funding path), "## Pre-launch checklist" (per the supplied items, using "[x] / [!] / [ ]" for pass / warn / fail), "## Post-launch tracking" (3-4 concrete actions).
- Be specific to THIS venture: use the brand name, tagline, ICP, pricing, and validation decision verbatim. Do NOT invent metrics or features that aren\'t in the receipt.
- UK context: GBP for money, Companies House / HMRC / ICO / FCA where relevant.
- Roughly 350-500 words. No filler, no lorem ipsum, no markdown code fences.`;

function buildAnnouncementUserPrompt(args: {
  manifest: VentureManifest;
  receipt: LaunchReceiptJson;
}): string {
  return `Write the launch announcement for "${args.receipt.brand.name || args.manifest.name}".

Receipt (JSON):

${JSON.stringify(
  {
    status: args.receipt.status,
    brand: args.receipt.brand,
    validation: args.receipt.validation,
    pricing: args.receipt.pricing,
    ukSetup: args.receipt.ukSetup,
    build: args.receipt.build,
    deploymentUrl: args.receipt.deploymentUrl,
    versionTag: args.receipt.versionTag,
    preLaunchChecklist: args.receipt.preLaunchChecklist,
  },
  null,
  2
)}`;
}

async function enrichAnnouncement(args: {
  manifest: VentureManifest;
  receipt: LaunchReceiptJson;
  callLlm: SaasLlmCaller;
}): Promise<{ markdown: string; usedLlm: boolean }> {
  try {
    const text = await args.callLlm({
      system: ANNOUNCEMENT_SYSTEM,
      user: buildAnnouncementUserPrompt({
        manifest: args.manifest,
        receipt: args.receipt,
      }),
    });
    const cleaned = text.trim();
    if (!cleaned) throw new Error("LLM returned empty announcement");
    return { markdown: cleaned, usedLlm: true };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    log.warn(`Launch announcement LLM enrichment failed -- using deterministic: ${m}`);
    return {
      markdown: renderDeterministicAnnouncement({
        manifest: args.manifest,
        receipt: args.receipt,
      }),
      usedLlm: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Main step
// ---------------------------------------------------------------------------

export async function createLaunchPackageStep(
  ctx: CreateLaunchPackageContext
): Promise<CreateLaunchPackageResult> {
  const dir = getStagePath(ctx.ventureRoot, "launch");
  await ctx.fs.mkdir(dir);

  const runId = ctx.runId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const [brand, validation, finance, uk, build] = await Promise.all([
    readBrandBrief(ctx.fs, ctx.ventureRoot),
    readValidation(ctx.fs, ctx.ventureRoot),
    readFinance(ctx.fs, ctx.ventureRoot),
    readUkSetup(ctx.fs, ctx.ventureRoot, ctx.manifest),
    readBuildHandoff(ctx.fs, ctx.ventureRoot),
  ]);

  const sources: string[] = [];
  if (brand.hasFile) sources.push("brand-brief.json");
  if (validation.hasFile) sources.push("validation-summary.json");
  if (finance.hasFile) sources.push("finance-plan.json");
  if (uk.hasFile) sources.push("uk-setup.json");
  if (build.hasHandoff) sources.push("build-handoff.json");

  const checklist = buildPreLaunchChecklist({ brand, validation, finance, uk, build });
  const status = deriveReceiptStatus(checklist);

  const receiptNoSource: LaunchReceiptJson = {
    schemaVersion: 1,
    stage: "LAUNCH",
    runId,
    ventureId: ctx.manifest.id,
    ventureName: ctx.manifest.name,
    ventureSlug: ctx.manifest.slug,
    launchedAt: new Date().toISOString(),
    status,
    deploymentUrl: build.deploymentUrl,
    versionTag: build.versionTag,
    buildRunId: build.buildRunId,
    brand: {
      name: brand.hasFile ? brand.name || null : null,
      tagline: brand.hasFile ? brand.tagline || null : null,
      targetAudience: brand.hasFile ? brand.targetAudience || null : null,
    },
    validation: {
      decision: validation.hasFile ? validation.decision || null : null,
      icp: validation.hasFile ? validation.icp || null : null,
    },
    pricing: {
      pricePoint:
        finance.pricePoint ?? (validation.hasFile ? validation.pricePoint || null : null),
      pricingModel: validation.hasFile ? validation.pricingModel || null : null,
      fundingRecommendation: finance.hasFile ? finance.fundingPath || null : null,
    },
    ukSetup: { entityType: uk.entityType, hasUkSetupCanvas: uk.hasFile },
    build: { hasHandoff: build.hasHandoff },
    preLaunchChecklist: checklist,
    sources,
    generationSource: "deterministic",
  };

  let announcementMd: string;
  let generationSource: LaunchReceiptJson["generationSource"];
  if (ctx.callLlm) {
    const out = await enrichAnnouncement({
      manifest: ctx.manifest,
      receipt: receiptNoSource,
      callLlm: ctx.callLlm,
    });
    announcementMd = out.markdown;
    generationSource = out.usedLlm ? "llm" : "deterministic-fallback";
  } else {
    announcementMd = renderDeterministicAnnouncement({
      manifest: ctx.manifest,
      receipt: receiptNoSource,
    });
    generationSource = "deterministic";
  }

  const receipt: LaunchReceiptJson = { ...receiptNoSource, generationSource };

  const receiptPath = `${dir}/launch-receipt.json`;
  const announcementPath = `${dir}/launch-announcement.md`;
  await ctx.fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  await ctx.fs.writeFile(
    announcementPath,
    announcementMd.endsWith("\n") ? announcementMd : `${announcementMd}\n`
  );

  log.info(
    `Launch package written (status: ${receipt.status}, generationSource: ${generationSource}, sources: ${sources.length})`
  );

  return { status: "done", receiptPath, announcementPath, receipt };
}
