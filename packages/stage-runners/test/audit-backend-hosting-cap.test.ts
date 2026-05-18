/**
 * Slice 7 of the backend arc -- audit rule
 * `finance.backend-hosting.exceeds-cap`.
 *
 * The rule reads `12_backend/backend-checkpoint.json` (BACKEND output)
 * and `05_finance/finance-canvas.json` (FINANCE input), looks up the
 * resolved engine's estimated monthly USD cost via
 * BACKEND_ENGINE_MONTHLY_USD_ESTIMATE, and emits a critical finding
 * gated at minStage LAUNCH_READY when estimate > cap. The
 * AdvancePreflight in apps/founder-desktop/src/lib/advance-gate.ts
 * then treats critical findings as blockers, so this rule is the
 * canonical refuse-LAUNCH gate.
 *
 * Tests live in the stage-runners suite (rather than pipeline-runner's
 * non-existent test config) because that's where every other
 * auditVentureStep test lives -- log-strings.test.ts already uses the
 * same in-memory fs + manifest helpers and the same vitest config
 * picks them up.
 *
 * Five cases:
 *   1. exceeds cap on supabase ($25) > $10 cap -> finding fires
 *   2. fits inside cap on supabase ($25) <= $30 cap -> no finding
 *   3. pocketbase ($0) <= 0 cap -> no finding (the default
 *      strict-by-default scaffold value)
 *   4. backend-checkpoint.json missing -> rule silently skips
 *   5. minStage gating: at SPEC_READY current stage, the rule does
 *      NOT fire even if the cap is exceeded (it's a LAUNCH gate)
 */
import { describe, expect, it } from "vitest";

import { auditVentureStep } from "@founder-os/pipeline-runner";
import { InMemoryFs } from "./_helpers/in-memory-fs.js";
import { makeManifest } from "./_helpers/manifest.js";

const RULE_ID = "finance.backend-hosting.exceeds-cap";

async function seedBackend(fs: InMemoryFs, engine: string): Promise<void> {
  await fs.writeFile(
    "/v/12_backend/backend-checkpoint.json",
    JSON.stringify({
      runId: "r",
      ventureSlug: "test",
      startedAt: "2026-05-13T00:00:00Z",
      status: "completed",
      instance: {
        ventureSlug: "test",
        engine,
        adminEmail: "f@x.test",
        provisionedAt: "2026-05-13T00:00:00Z",
      },
    })
  );
}

async function seedFinance(fs: InMemoryFs, cap: number | null): Promise<void> {
  await fs.writeFile(
    "/v/05_finance/finance-canvas.json",
    JSON.stringify({
      schemaVersion: 1,
      stage: "FINANCE",
      status: "checkpoint",
      monthlyBudgetCapGBP: null,
      startingCapitalGBP: null,
      backendHostingMonthlyUsdCap: cap,
      revenueModel: null,
      pricingTiers: [],
      costProjections: null,
      runwayMonths: null,
      note: "",
    })
  );
}

describe("audit rule: finance.backend-hosting.exceeds-cap", () => {
  it("fires (critical) when supabase ($25) exceeds the $10 cap", async () => {
    const fs = new InMemoryFs();
    await seedBackend(fs, "supabase");
    await seedFinance(fs, 10);

    const result = await auditVentureStep({
      fs,
      manifest: makeManifest(),
      ventureRoot: "/v",
      ventureStage: "LAUNCH_READY",
    });

    const finding = result.findings.find((f) => f.ruleId === RULE_ID);
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("critical");
    expect(finding?.message).toContain("supabase");
    expect(finding?.message).toContain("25");
    expect(finding?.message).toContain("10");
  });

  it("does NOT fire when supabase ($25) fits inside a $30 cap", async () => {
    const fs = new InMemoryFs();
    await seedBackend(fs, "supabase");
    await seedFinance(fs, 30);

    const result = await auditVentureStep({
      fs,
      manifest: makeManifest(),
      ventureRoot: "/v",
      ventureStage: "LAUNCH_READY",
    });

    expect(result.findings.find((f) => f.ruleId === RULE_ID)).toBeUndefined();
  });

  it("does NOT fire when pocketbase ($0) and cap=0 (the strict default)", async () => {
    const fs = new InMemoryFs();
    await seedBackend(fs, "pocketbase");
    await seedFinance(fs, 0);

    const result = await auditVentureStep({
      fs,
      manifest: makeManifest(),
      ventureRoot: "/v",
      ventureStage: "LAUNCH_READY",
    });

    expect(result.findings.find((f) => f.ruleId === RULE_ID)).toBeUndefined();
  });

  it("silently skips when backend-checkpoint.json is missing", async () => {
    const fs = new InMemoryFs();
    // No backend checkpoint -- only finance canvas exists.
    await seedFinance(fs, 0);

    const result = await auditVentureStep({
      fs,
      manifest: makeManifest(),
      ventureRoot: "/v",
      ventureStage: "LAUNCH_READY",
    });

    expect(result.findings.find((f) => f.ruleId === RULE_ID)).toBeUndefined();
  });

  it("does NOT fire at SPEC_READY -- LAUNCH gate only", async () => {
    const fs = new InMemoryFs();
    await seedBackend(fs, "supabase");
    await seedFinance(fs, 10);

    const result = await auditVentureStep({
      fs,
      manifest: makeManifest(),
      ventureRoot: "/v",
      ventureStage: "SPEC_READY",
    });

    expect(result.findings.find((f) => f.ruleId === RULE_ID)).toBeUndefined();
    // The deferred-rules meta footer should be present because we're
    // pre-LAUNCH and the rule lives at LAUNCH_READY.
    expect(result.skippedForStage).toBeGreaterThan(0);
  });
});
