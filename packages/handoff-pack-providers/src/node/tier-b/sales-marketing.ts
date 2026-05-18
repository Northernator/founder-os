/**
 * Slice 7 -- sales-marketing-tier Tier-B steps (6 docs).
 *
 *   - go-to-market-plan  -- audience + channels + timeline (LLM).
 *   - sales-playbook     -- stages + scripts from CRM (pure render).
 *   - buyer-personas     -- personas synthesis (LLM).
 *   - crm-process        -- pipeline stages + fields (pure render).
 *   - website-copy       -- homepage / features / pricing / FAQ / about (LLM).
 *   - launch-plan        -- channels + dates from LAUNCH (pure render).
 *
 * NODE-ONLY.
 */
import { join } from "node:path";
import {
  getBrandKitDir,
  getCrmConfigPath,
  getCrmSegmentsDir,
  getStagePath,
} from "@founder-os/workspace-core";
import {
  bulletList,
  callLlmStrict,
  isoDate,
  readJsonIfExists,
  readMarkdownFiles,
  readTextIfExists,
  todoCallout,
  truncate,
} from "../golden/helpers.js";
import type { GoldenStep, GoldenStepResult } from "./types.js";

type BrandBriefLike = {
  mission?: string;
  audience?: string;
  tone?: string | string[];
  positioning?: string;
};
type ValidationCanvasLike = {
  icpDescription?: string;
  icpPain?: string;
  icpRole?: string;
  pricingTiers?: Array<{ name?: string; priceGbp?: number; features?: string[] }>;
};
type LaunchReceiptLike = {
  channels?: string[];
  preLaunchChecklist?: string[];
  launchDate?: string;
  dates?: Array<{ label?: string; date?: string }>;
};
type CrmConfigLike = {
  pipeline?: {
    stages?: Array<{ name?: string; description?: string; criteria?: string }>;
    fields?: Array<{ name?: string; type?: string; required?: boolean }>;
  };
  templates?: Record<string, string>;
};

async function loadBrandBrief(root: string): Promise<BrandBriefLike | null> {
  return readJsonIfExists<BrandBriefLike>(join(getBrandKitDir(root), "brand-brief.json"));
}
async function loadValidationCanvas(root: string): Promise<ValidationCanvasLike | null> {
  return readJsonIfExists<ValidationCanvasLike>(
    join(getStagePath(root, "validation"), "validation-canvas.json")
  );
}
async function loadLaunchReceipt(root: string): Promise<LaunchReceiptLike | null> {
  return readJsonIfExists<LaunchReceiptLike>(
    join(getStagePath(root, "launch"), "launch-receipt.json")
  );
}
async function loadCrmConfig(root: string): Promise<CrmConfigLike | null> {
  return readJsonIfExists<CrmConfigLike>(getCrmConfigPath(root));
}

// ---------------------------------------------------------------------------
// go-to-market-plan
// ---------------------------------------------------------------------------

export const createGoToMarketPlanStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const brandBrief = await loadBrandBrief(ctx.ventureRoot);
  if (brandBrief) sourcesRead.push("03_brand/brand-kit/brand-brief.json");
  const launch = await loadLaunchReceipt(ctx.ventureRoot);
  if (launch) sourcesRead.push("08_launch/launch-receipt.json");
  const crm = await loadCrmConfig(ctx.ventureRoot);
  if (crm) sourcesRead.push("11_crm/crm-config.json");

  const detAudience = brandBrief?.audience?.trim() ||
    todoCallout("AUDIENCE", "set audience in 03_brand/brand-kit/brand-brief.json");

  const channels = Array.isArray(launch?.channels) ? launch!.channels! : [];
  const detChannels = channels.length > 0
    ? bulletList(channels, "")
    : todoCallout("CHANNELS", "no channels in launch-receipt.json -- run LAUNCH stage");

  const dates = Array.isArray(launch?.dates) ? launch!.dates! : [];
  const detTimeline = dates.length > 0
    ? bulletList(dates.map((d) => `${d.label ?? "?"}: ${d.date ?? "?"}`), "")
    : (launch?.launchDate
      ? `Launch date: ${launch.launchDate}`
      : todoCallout("TIMELINE", "set launchDate or dates[] in launch-receipt.json"));

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    AUDIENCE: truncate(detAudience, 1200),
    CHANNELS: truncate(detChannels, 2000),
    TIMELINE: truncate(detTimeline, 2000),
    CURRENT_DATE: isoDate(ctx.now()),
  };

  let usedLlm = false;
  if (ctx.callLlm && (brandBrief || launch)) {
    try {
      const synth = await callLlmStrict(ctx.callLlm, {
        system: `Write the AUDIENCE paragraph of a Go-To-Market plan for "${ctx.ventureName}". 1-2 paragraphs of plain prose. ~120-200 words. Specific to who you are selling to first.`,
        user: `Audience: ${brandBrief?.audience ?? "(none)"}\nPositioning: ${brandBrief?.positioning ?? "(none)"}\nChannels: ${JSON.stringify(channels)}`,
      });
      placeholders.AUDIENCE = synth;
      usedLlm = true;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notes.push(`go-to-market-plan: LLM failed -- using deterministic: ${m}`);
    }
  }

  return mkResult("go-to-market-plan", placeholders, sourcesRead, usedLlm, notes);
};

// ---------------------------------------------------------------------------
// sales-playbook
// ---------------------------------------------------------------------------

export const createSalesPlaybookStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const crm = await loadCrmConfig(ctx.ventureRoot);
  if (crm) sourcesRead.push("11_crm/crm-config.json");

  const stages = Array.isArray(crm?.pipeline?.stages) ? crm!.pipeline!.stages! : [];
  const stageLines: string[] = [];
  if (stages.length > 0) {
    for (const s of stages) {
      const name = (s.name ?? "?").trim();
      const desc = (s.description ?? "").trim();
      const crit = (s.criteria ?? "").trim();
      stageLines.push(`### ${name}`);
      if (desc) stageLines.push(desc);
      if (crit) stageLines.push(`_Criteria:_ ${crit}`);
      stageLines.push("");
    }
  } else {
    stageLines.push(todoCallout("STAGES", "no pipeline.stages in crm-config.json -- run CRM stage"));
  }

  const templates = crm?.templates ?? {};
  const scriptKeys = Object.keys(templates);
  const scriptLines: string[] = [];
  if (scriptKeys.length > 0) {
    for (const k of scriptKeys.slice(0, 6)) {
      scriptLines.push(`### ${k}`);
      scriptLines.push("```");
      scriptLines.push(truncate(templates[k] ?? "", 500));
      scriptLines.push("```");
      scriptLines.push("");
    }
  } else {
    scriptLines.push(todoCallout("SCRIPTS", "no templates in crm-config.json -- add outreach scripts"));
  }

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    STAGES: truncate(stageLines.join("\n"), 5000),
    SCRIPTS: truncate(scriptLines.join("\n"), 5000),
    CURRENT_DATE: isoDate(ctx.now()),
  };

  return mkResult("sales-playbook", placeholders, sourcesRead, false, notes);
};

// ---------------------------------------------------------------------------
// buyer-personas
// ---------------------------------------------------------------------------

export const createBuyerPersonasStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const validation = await loadValidationCanvas(ctx.ventureRoot);
  if (validation) sourcesRead.push("02_validation/validation-canvas.json");

  const segments = await readMarkdownFiles(getCrmSegmentsDir(ctx.ventureRoot), { limit: 6 });
  for (const s of segments) sourcesRead.push(`11_crm/segments/${s.filename}`);

  const role = validation?.icpRole?.trim() || "";
  const pain = validation?.icpPain?.trim() || "";
  const description = validation?.icpDescription?.trim() || "";

  const personaLines: string[] = [];
  if (segments.length > 0) {
    for (const s of segments) {
      personaLines.push(`### ${s.filename.replace(/\.md$/, "")}`);
      personaLines.push("");
      personaLines.push(truncate(s.content, 600));
      personaLines.push("");
    }
  } else {
    personaLines.push("### Decision-maker");
    personaLines.push(role || todoCallout("PERSONA_ROLE", "set icpRole in validation-canvas"));
    personaLines.push("");
    personaLines.push("### Pain");
    personaLines.push(pain || todoCallout("PERSONA_PAIN", "set icpPain in validation-canvas"));
    personaLines.push("");
    personaLines.push("### Description");
    personaLines.push(description || todoCallout("PERSONA_DESC", "set icpDescription in validation-canvas"));
  }

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    PERSONAS: truncate(personaLines.join("\n"), 5000),
    CURRENT_DATE: isoDate(ctx.now()),
  };

  let usedLlm = false;
  if (ctx.callLlm && (description || pain || segments.length > 0)) {
    try {
      const synth = await callLlmStrict(ctx.callLlm, {
        system: `Write BUYER PERSONAS for "${ctx.ventureName}" -- 2-3 personas, each with: role, description, pain, current solution, buying trigger. Markdown H3 per persona. ~250-450 words total.`,
        user: `ICP: ${JSON.stringify({ description, role, pain })}\nSegments excerpt: ${segments.slice(0, 2).map((s) => `${s.filename}: ${truncate(s.content, 400)}`).join("\n\n")}`,
      });
      placeholders.PERSONAS = truncate(synth, 5000);
      usedLlm = true;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notes.push(`buyer-personas: LLM failed -- using deterministic: ${m}`);
    }
  }

  return mkResult("buyer-personas", placeholders, sourcesRead, usedLlm, notes);
};

// ---------------------------------------------------------------------------
// crm-process
// ---------------------------------------------------------------------------

export const createCrmProcessStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const crm = await loadCrmConfig(ctx.ventureRoot);
  if (crm) sourcesRead.push("11_crm/crm-config.json");

  const stages = Array.isArray(crm?.pipeline?.stages) ? crm!.pipeline!.stages! : [];
  const stageLines: string[] = [];
  if (stages.length > 0) {
    stageLines.push("| Stage | Description |");
    stageLines.push("|---|---|");
    for (const s of stages) {
      const name = (s.name ?? "?").replace(/\|/g, "\\|");
      const desc = (s.description ?? "").replace(/\|/g, "\\|");
      stageLines.push(`| ${name} | ${desc} |`);
    }
  } else {
    stageLines.push(todoCallout("STAGES", "no pipeline.stages in crm-config.json"));
  }

  const fields = Array.isArray(crm?.pipeline?.fields) ? crm!.pipeline!.fields! : [];
  const fieldLines: string[] = [];
  if (fields.length > 0) {
    fieldLines.push("| Field | Type | Required |");
    fieldLines.push("|---|---|---|");
    for (const f of fields) {
      const n = (f.name ?? "?").replace(/\|/g, "\\|");
      const t = (f.type ?? "?").replace(/\|/g, "\\|");
      const r = f.required ? "yes" : "no";
      fieldLines.push(`| ${n} | ${t} | ${r} |`);
    }
  } else {
    fieldLines.push(todoCallout("FIELDS", "no pipeline.fields in crm-config.json"));
  }

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    STAGES: truncate(stageLines.join("\n"), 4000),
    FIELDS: truncate(fieldLines.join("\n"), 4000),
    CURRENT_DATE: isoDate(ctx.now()),
  };

  return mkResult("crm-process", placeholders, sourcesRead, false, notes);
};

// ---------------------------------------------------------------------------
// website-copy
// ---------------------------------------------------------------------------

export const createWebsiteCopyStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const brandBrief = await loadBrandBrief(ctx.ventureRoot);
  if (brandBrief) sourcesRead.push("03_brand/brand-kit/brand-brief.json");
  const launch = await loadLaunchReceipt(ctx.ventureRoot);
  if (launch) sourcesRead.push("08_launch/launch-receipt.json");

  const announcement = await readTextIfExists(
    join(getStagePath(ctx.ventureRoot, "launch"), "launch-announcement.md")
  );
  if (announcement) sourcesRead.push("08_launch/launch-announcement.md");

  const homepage = brandBrief?.mission?.trim() || todoCallout("HOMEPAGE", "set mission in brand-brief");
  const features = todoCallout("FEATURES", "founder fills (or run PRODUCT_SPEC stage to surface features)");
  const pricing = todoCallout("PRICING", "founder fills (or VALIDATION stage to surface pricing tiers)");
  const faq = todoCallout("FAQ", "founder fills");
  const about = brandBrief?.positioning?.trim() || todoCallout("ABOUT", "set positioning in brand-brief");

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    HOMEPAGE: truncate(homepage, 1500),
    FEATURES: features,
    PRICING: pricing,
    FAQ: faq,
    ABOUT: truncate(about, 1500),
    CURRENT_DATE: isoDate(ctx.now()),
  };

  let usedLlm = false;
  if (ctx.callLlm && brandBrief) {
    try {
      const synth = await callLlmStrict(ctx.callLlm, {
        system: `Write the HOMEPAGE hero copy for "${ctx.ventureName}". 1 punchy headline + 1 subhead + 1 CTA line. ~30-60 words total. No markdown. Match the tone supplied.`,
        user: `Mission: ${brandBrief.mission ?? "(none)"}\nAudience: ${brandBrief.audience ?? "(none)"}\nTone: ${JSON.stringify(brandBrief.tone ?? "(none)")}\nAnnouncement excerpt: ${truncate(announcement ?? "(none)", 600)}`,
      });
      placeholders.HOMEPAGE = synth;
      usedLlm = true;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notes.push(`website-copy: LLM failed -- using deterministic homepage: ${m}`);
    }
  }

  return mkResult("website-copy", placeholders, sourcesRead, usedLlm, notes);
};

// ---------------------------------------------------------------------------
// launch-plan
// ---------------------------------------------------------------------------

export const createLaunchPlanStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const launch = await loadLaunchReceipt(ctx.ventureRoot);
  if (launch) sourcesRead.push("08_launch/launch-receipt.json");

  const channels = Array.isArray(launch?.channels) ? launch!.channels! : [];
  const detChannels = channels.length > 0
    ? bulletList(channels, "")
    : todoCallout("CHANNELS", "no channels in launch-receipt.json -- run LAUNCH stage");

  const dates = Array.isArray(launch?.dates) ? launch!.dates! : [];
  const dateLines: string[] = [];
  if (dates.length > 0) {
    dateLines.push("| Milestone | Date |");
    dateLines.push("|---|---|");
    for (const d of dates) {
      dateLines.push(`| ${d.label ?? "?"} | ${d.date ?? "?"} |`);
    }
  } else if (launch?.launchDate) {
    dateLines.push(`Launch date: ${launch.launchDate}`);
  } else {
    dateLines.push(todoCallout("DATES", "set dates[] or launchDate in launch-receipt.json"));
  }

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    CHANNELS: truncate(detChannels, 3000),
    DATES: truncate(dateLines.join("\n"), 3000),
    CURRENT_DATE: isoDate(ctx.now()),
  };

  return mkResult("launch-plan", placeholders, sourcesRead, false, notes);
};

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function mkResult(
  docId: string,
  placeholders: Record<string, string>,
  sourcesRead: string[],
  usedLlm: boolean,
  notes: string[]
): GoldenStepResult {
  return { docId, placeholders, sourcesRead, usedLlm, notes };
}
