/**
 * Slice 7 -- finance-admin-tier Tier-B steps.
 *
 * Two docs:
 *   - startup-budget   -- initial setup costs by category.
 *   - cashflow-forecast -- money in and out by month.
 *
 * NODE-ONLY. Both are pure renders of finance-plan.json (numbers --
 * never LLM, to avoid hallucinated figures). Deterministic fallback
 * for both is a TODO callout when finance-plan.json is missing.
 */
import { join } from "node:path";
import { getStagePath } from "@founder-os/workspace-core";
import {
  isoDate,
  readJsonIfExists,
  todoCallout,
  truncate,
} from "../golden/helpers.js";
import type { GoldenStep, GoldenStepResult } from "./types.js";

type FinancePlanLike = {
  costs?: {
    oneOffCategories?: Array<{ name?: string; amountGbp?: number; notes?: string }>;
    monthlyCategories?: Array<{ name?: string; amountGbp?: number; notes?: string }>;
  };
  startupBudget?: Array<{ category?: string; amountGbp?: number; notes?: string }>;
  cashflow?: Array<{ month?: string; revenueGbp?: number; expensesGbp?: number; netGbp?: number }>;
  monthly?: Array<{ month?: string; revenueGbp?: number; expensesGbp?: number }>;
};

async function loadFinancePlan(ventureRoot: string): Promise<FinancePlanLike | null> {
  return readJsonIfExists<FinancePlanLike>(
    join(getStagePath(ventureRoot, "finance"), "finance-plan.json")
  );
}

// ---------------------------------------------------------------------------
// startup-budget
// ---------------------------------------------------------------------------

export const createStartupBudgetStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const plan = await loadFinancePlan(ctx.ventureRoot);
  if (plan) sourcesRead.push("05_finance/finance-plan.json");

  const lines: string[] = [];
  let total = 0;
  const rows: Array<{ category: string; amount: number; notes: string }> = [];

  if (Array.isArray(plan?.startupBudget) && plan!.startupBudget!.length > 0) {
    for (const e of plan!.startupBudget!) {
      const cat = (e.category ?? "").trim() || "(unnamed)";
      const amt = typeof e.amountGbp === "number" ? e.amountGbp : 0;
      const n = (e.notes ?? "").trim();
      rows.push({ category: cat, amount: amt, notes: n });
      total += amt;
    }
  } else if (Array.isArray(plan?.costs?.oneOffCategories)) {
    for (const c of plan!.costs!.oneOffCategories!) {
      const cat = (c.name ?? "").trim() || "(unnamed)";
      const amt = typeof c.amountGbp === "number" ? c.amountGbp : 0;
      const n = (c.notes ?? "").trim();
      rows.push({ category: cat, amount: amt, notes: n });
      total += amt;
    }
  }

  if (rows.length === 0) {
    lines.push(todoCallout("CATEGORIES", "no startup budget in finance-plan.json -- run FINANCE stage or fill manually"));
  } else {
    lines.push("| Category | Amount (GBP) | Notes |");
    lines.push("|---|--:|---|");
    for (const r of rows) {
      const fmt = r.amount.toLocaleString("en-GB", { maximumFractionDigits: 0 });
      const safeNotes = r.notes.replace(/\|/g, "\\|");
      lines.push(`| ${r.category} | ${fmt} | ${safeNotes} |`);
    }
    lines.push("| **Total** | **" + total.toLocaleString("en-GB", { maximumFractionDigits: 0 }) + "** | |");
  }

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    CATEGORIES: truncate(lines.join("\n"), 6000),
    CURRENT_DATE: isoDate(ctx.now()),
  };

  // No LLM. Numbers must come from finance-plan.json verbatim.
  return mkResult("startup-budget", placeholders, sourcesRead, false, notes);
};

// ---------------------------------------------------------------------------
// cashflow-forecast
// ---------------------------------------------------------------------------

export const createCashflowForecastStep: GoldenStep = async (ctx) => {
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  const plan = await loadFinancePlan(ctx.ventureRoot);
  if (plan) sourcesRead.push("05_finance/finance-plan.json");

  const rows: Array<{ month: string; revenue: number; expenses: number; net: number }> = [];
  const source = Array.isArray(plan?.cashflow) && plan!.cashflow!.length > 0
    ? plan!.cashflow!
    : (Array.isArray(plan?.monthly) ? plan!.monthly! : []);

  for (const m of source) {
    const month = (m.month ?? "").trim() || "(unlabelled)";
    const rev = typeof m.revenueGbp === "number" ? m.revenueGbp : 0;
    const exp = typeof m.expensesGbp === "number" ? m.expensesGbp : 0;
    const netRaw = "netGbp" in (m as object) ? (m as { netGbp?: number }).netGbp : undefined;
    const net = typeof netRaw === "number" ? netRaw : rev - exp;
    rows.push({ month, revenue: rev, expenses: exp, net });
  }

  const lines: string[] = [];
  if (rows.length === 0) {
    lines.push(todoCallout("MONTHS", "no monthly cashflow in finance-plan.json -- run FINANCE stage or fill manually"));
  } else {
    lines.push("| Month | Revenue (GBP) | Expenses (GBP) | Net (GBP) |");
    lines.push("|---|--:|--:|--:|");
    for (const r of rows) {
      const f = (n: number): string => n.toLocaleString("en-GB", { maximumFractionDigits: 0 });
      lines.push(`| ${r.month} | ${f(r.revenue)} | ${f(r.expenses)} | ${f(r.net)} |`);
    }
  }

  const placeholders: Record<string, string> = {
    COMPANY_NAME: ctx.ventureName,
    MONTHS: truncate(lines.join("\n"), 8000),
    CURRENT_DATE: isoDate(ctx.now()),
  };

  return mkResult("cashflow-forecast", placeholders, sourcesRead, false, notes);
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
