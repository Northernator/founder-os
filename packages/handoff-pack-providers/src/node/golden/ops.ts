/**
 * Slice 6 -- ops-tier Golden steps.
 *
 * Three docs:
 *   - testing-strategy  -- unit/integration/E2E/security/perf strategy + AUDIT findings.
 *   - deployment-guide  -- local -> staging -> production pipeline.
 *   - financial-model   -- revenue / costs / runway / hiring plan from 05_finance.
 *
 * NODE-ONLY. Reads:
 *   07_build/audits/
 *   12_backend/backend-export.json
 *   05_finance/finance-plan.json
 *   02_validation/validation-summary.json
 */
import { join } from "node:path";
import {
  getBackendExportPath,
  getStagePath,
} from "@founder-os/workspace-core";
import {
  bulletList,
  callLlmStrict,
  isoDate,
  readDirIfExists,
  readJsonIfExists,
  readMarkdownFiles,
  readTextIfExists,
  todoCallout,
  truncate,
} from "./helpers.js";
import type { GoldenStep, GoldenStepResult } from "./types.js";

// ---------------------------------------------------------------------------
// Shapes (best-effort)
// ---------------------------------------------------------------------------

type AuditFindingLike = {
  id?: string;
  title?: string;
  severity?: string;
  category?: string;
  recommendation?: string;
};

type AuditReportLike = {
  findings?: AuditFindingLike[];
  testGaps?: string[];
  coverage?: { unit?: number; integration?: number; e2e?: number };
};

type FinancePlanLike = {
  revenue?: {
    monthlyRecurringTargetGbp?: number;
    pricePointGbp?: number;
    targetCustomers?: number;
  };
  costs?: {
    totalMonthlyGbp?: number;
    items?: Array<{ name?: string; monthlyGbp?: number }>;
  };
  runway?: {
    startingBalanceGbp?: number;
    monthsAtCurrentBurn?: number;
    breakEvenMonth?: number | string;
  };
  hires?: Array<{ role?: string; whenMonth?: number; monthlySalaryGbp?: number }>;
  fundingRecommendation?: string;
};

type BackendExportLike = {
  framework?: string;
  database?: string;
  deployment?: {
    target?: string;
    environments?: string[];
    cicd?: string;
    migrations?: string;
  };
};

// ---------------------------------------------------------------------------
// testing-strategy
// ---------------------------------------------------------------------------

export const createTestingStrategyStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const auditsDir = join(getStagePath(ctx.ventureRoot, "build"), "audits");
  const auditFiles = await readDirIfExists(auditsDir);
  const auditJson = auditFiles.find((f) => f.endsWith(".json"));
  let audit: AuditReportLike | null = null;
  if (auditJson) {
    audit = await readJsonIfExists<AuditReportLike>(join(auditsDir, auditJson));
    if (audit) sourcesRead.push(`07_build/audits/${auditJson}`);
  }
  const auditMds = await readMarkdownFiles(auditsDir, { limit: 2 });
  for (const a of auditMds) sourcesRead.push(`07_build/audits/${a.filename}`);

  const findings = Array.isArray(audit?.findings) ? audit!.findings! : [];
  const testGaps = Array.isArray(audit?.testGaps) ? audit!.testGaps! : [];

  const detTestTypes = [
    "- **Unit tests** -- core business logic (target: 80% line coverage on `src/`).",
    "- **Integration tests** -- pipeline + DB round-trips against real Postgres (no mocks for migration-affected paths).",
    "- **End-to-end tests** -- happy-path user flows via Playwright on staging.",
    "- **Security tests** -- dependency audit (Snyk / `pnpm audit`) on every PR; SCA scan weekly.",
    "- **Performance tests** -- p95 < 500ms on hot read paths; baseline captured via k6.",
  ].join("\n");

  const coverageLines: string[] = [];
  if (audit?.coverage?.unit != null) coverageLines.push(`- Unit: ${audit.coverage.unit}%`);
  if (audit?.coverage?.integration != null) coverageLines.push(`- Integration: ${audit.coverage.integration}%`);
  if (audit?.coverage?.e2e != null) coverageLines.push(`- E2E: ${audit.coverage.e2e}%`);
  if (coverageLines.length === 0) {
    coverageLines.push("- Unit: 80% (target)");
    coverageLines.push("- Integration: 60% (target)");
    coverageLines.push("- E2E: critical user journeys only");
  }
  const gapBlock = findings.length === 0 && testGaps.length === 0
    ? ""
    : "\n\n_Gaps surfaced by AUDIT:_\n" + bulletList(
        [
          ...findings.filter((f) => (f.category ?? "").toLowerCase().includes("test")).map((f) => `${f.title ?? f.id ?? "finding"}: ${f.recommendation ?? "(no rec)"}`),
          ...testGaps,
        ],
        ""
      );

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    CURRENT_DATE: isoDate(ctx.now()),
    TEST_TYPES: detTestTypes,
    COVERAGE_TARGETS: coverageLines.join("\n") + gapBlock,
  };

  let usedLlm = false;
  if (ctx.callLlm && (findings.length > 0 || testGaps.length > 0)) {
    try {
      const synth = await callLlmStrict(ctx.callLlm, {
        system: `You are writing the TEST_TYPES section of a testing strategy for "${ctx.ventureName}". Output a markdown bullet list covering unit, integration, E2E, security, and performance testing. Each bullet should specify what is tested + the tool + the target. Tie recommendations to AUDIT findings where present. ~250-450 words.`,
        user: `Audit findings:\n${JSON.stringify(findings.slice(0, 20), null, 2)}\n\nTest gaps:\n${JSON.stringify(testGaps, null, 2)}`,
      });
      placeholders.TEST_TYPES = synth;
      usedLlm = true;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notes.push(`testing-strategy: LLM failed -- using deterministic: ${m}`);
    }
  }

  return { docId: "testing-strategy", placeholders, sourcesRead, usedLlm, notes };
};

// ---------------------------------------------------------------------------
// deployment-guide
// ---------------------------------------------------------------------------

export const createDeploymentGuideStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const backend = await readJsonIfExists<BackendExportLike>(getBackendExportPath(ctx.ventureRoot));
  if (backend) sourcesRead.push("12_backend/backend-export.json");

  const buildDir = getStagePath(ctx.ventureRoot, "build");
  const buildReadme = await readTextIfExists(join(buildDir, "README.md"));
  if (buildReadme) sourcesRead.push("07_build/README.md");

  const target = backend?.deployment?.target ?? "TBD";
  const cicd = backend?.deployment?.cicd ?? "GitHub Actions";
  const envs = Array.isArray(backend?.deployment?.environments) && backend!.deployment!.environments!.length > 0
    ? backend!.deployment!.environments!
    : ["local", "staging", "production"];
  const migrations = backend?.deployment?.migrations ?? "TBD";

  const stagesBlock: string[] = [];
  for (const env of envs) {
    stagesBlock.push(`### ${env}`);
    stagesBlock.push("");
    if (env === "local") {
      stagesBlock.push("1. Clone repo, run `pnpm install`.");
      stagesBlock.push("2. Copy `.env.example` -> `.env.local`.");
      stagesBlock.push("3. `pnpm dev` -- starts the app + a local DB via docker-compose.");
    } else if (env === "staging") {
      stagesBlock.push(`1. Merging to \`main\` triggers ${cicd}; pipeline runs tests, builds, and deploys to ${target} staging.`);
      stagesBlock.push("2. Smoke-test runner asserts core flows green.");
      stagesBlock.push(`3. Run DB migrations: \`${migrations}\`.`);
    } else if (env === "production") {
      stagesBlock.push("1. Promote staging build via GitHub release tag (semver).");
      stagesBlock.push(`2. ${cicd} deploys the tagged build to ${target} production.`);
      stagesBlock.push("3. Post-deploy smoke (status page check + canary metric).");
      stagesBlock.push("4. Rollback: redeploy previous tag; migrations are forward-only -- write a compensating migration if needed.");
    } else {
      stagesBlock.push(`1. ${cicd} deploys to ${env}.`);
      stagesBlock.push(`2. Run migrations: \`${migrations}\`.`);
    }
    stagesBlock.push("");
  }
  const detStages = backend
    ? stagesBlock.join("\n")
    : todoCallout("STAGES", "no backend-export.json -- run BACKEND stage to populate deployment metadata");

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    CURRENT_DATE: isoDate(ctx.now()),
    STAGES: truncate(detStages, 4000),
  };

  let usedLlm = false;
  if (ctx.callLlm && backend) {
    try {
      const synth = await callLlmStrict(ctx.callLlm, {
        system: `You are writing the STAGES section of a deployment guide for "${ctx.ventureName}". Output markdown with one ### heading per environment (local/staging/production) and concrete numbered steps under each, citing the tools used. ~300-500 words.`,
        user: `Backend deployment metadata:\n${JSON.stringify(backend.deployment ?? {}, null, 2)}\nFramework: ${backend.framework}\nDatabase: ${backend.database}`,
      });
      placeholders.STAGES = synth;
      usedLlm = true;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notes.push(`deployment-guide: LLM failed -- using deterministic: ${m}`);
    }
  }

  return { docId: "deployment-guide", placeholders, sourcesRead, usedLlm, notes };
};

// ---------------------------------------------------------------------------
// financial-model
// ---------------------------------------------------------------------------

export const createFinancialModelStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const financeDir = getStagePath(ctx.ventureRoot, "finance");
  const plan = await readJsonIfExists<FinancePlanLike>(join(financeDir, "finance-plan.json"));
  if (plan) sourcesRead.push("05_finance/finance-plan.json");

  const fmtGbp = (n: number | undefined) => (typeof n === "number" ? `£${n.toLocaleString("en-GB")}` : "TBD");

  // REVENUE
  const revenueLines: string[] = [];
  if (plan?.revenue) {
    if (plan.revenue.monthlyRecurringTargetGbp != null) revenueLines.push(`- **Monthly recurring target:** ${fmtGbp(plan.revenue.monthlyRecurringTargetGbp)}/mo`);
    if (plan.revenue.pricePointGbp != null) revenueLines.push(`- **Price point:** ${fmtGbp(plan.revenue.pricePointGbp)}/customer/mo`);
    if (plan.revenue.targetCustomers != null) revenueLines.push(`- **Target customers (12 mo):** ${plan.revenue.targetCustomers.toLocaleString("en-GB")}`);
  }
  const detRevenue = revenueLines.length > 0
    ? revenueLines.join("\n")
    : todoCallout("REVENUE", "no revenue block in finance-plan.json -- run FINANCE stage");

  // COSTS
  let detCosts: string;
  if (plan?.costs?.items && plan.costs.items.length > 0) {
    const lines = [`- **Total monthly:** ${fmtGbp(plan.costs.totalMonthlyGbp)}`];
    for (const item of plan.costs.items.slice(0, 15)) {
      lines.push(`  - ${item.name ?? "(unnamed)"}: ${fmtGbp(item.monthlyGbp)}/mo`);
    }
    detCosts = lines.join("\n");
  } else if (plan?.costs?.totalMonthlyGbp != null) {
    detCosts = `- **Total monthly:** ${fmtGbp(plan.costs.totalMonthlyGbp)}`;
  } else {
    detCosts = todoCallout("COSTS", "no costs in finance-plan.json -- fill cost items in 05_finance");
  }

  // RUNWAY
  const runwayLines: string[] = [];
  if (plan?.runway) {
    if (plan.runway.startingBalanceGbp != null) runwayLines.push(`- **Starting balance:** ${fmtGbp(plan.runway.startingBalanceGbp)}`);
    if (plan.runway.monthsAtCurrentBurn != null) runwayLines.push(`- **Runway at current burn:** ${plan.runway.monthsAtCurrentBurn} months`);
    if (plan.runway.breakEvenMonth != null) runwayLines.push(`- **Break-even month:** ${plan.runway.breakEvenMonth}`);
  }
  const detRunway = runwayLines.length > 0
    ? runwayLines.join("\n")
    : todoCallout("RUNWAY", "no runway block -- set starting balance + burn in 05_finance canvas");

  // HIRES
  const hires = Array.isArray(plan?.hires) ? plan!.hires! : [];
  const detHires = hires.length > 0
    ? hires.slice(0, 12)
        .map((h) => `- **${h.role ?? "TBD"}** (month ${h.whenMonth ?? "?"}): ${fmtGbp(h.monthlySalaryGbp)}/mo`)
        .join("\n")
    : "_No hires planned in v1 -- founder is the sole operator until product-market fit._";

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    CURRENT_DATE: isoDate(ctx.now()),
    REVENUE: detRevenue,
    COSTS: detCosts,
    RUNWAY: detRunway,
    HIRES: detHires,
  };

  let usedLlm = false;
  if (ctx.callLlm && plan) {
    try {
      const synth = await callLlmStrict(ctx.callLlm, {
        system: `You are writing the RUNWAY narrative for a financial model for "${ctx.ventureName}". Output 1-2 short paragraphs of plain prose explaining the runway position, break-even outlook, and funding recommendation. ~120-200 words. UK context (GBP).`,
        user: `Finance plan:\n${JSON.stringify({ revenue: plan.revenue, costs: plan.costs, runway: plan.runway, fundingRecommendation: plan.fundingRecommendation }, null, 2)}`,
      });
      placeholders.RUNWAY = synth;
      usedLlm = true;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      notes.push(`financial-model: LLM failed -- using deterministic: ${m}`);
    }
  }

  return { docId: "financial-model", placeholders, sourcesRead, usedLlm, notes };
};

export type { GoldenStepResult };
