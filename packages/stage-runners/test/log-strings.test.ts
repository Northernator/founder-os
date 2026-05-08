/**
 * Log-string contract tests.
 *
 * The desktop adoption helpers (run-research-stage / run-brand-stage /
 * run-product-stage / etc) parse `result.logs[].message` to derive
 * UI-friendly per-step status (deriveSteps / deriveCounts). If a
 * runner silently changes the strings it emits, the helpers
 * downgrade gracefully -- toast counts go to zero -- without any
 * compile-time signal. This file is the safety net.
 *
 * Strategy: vi.mock @founder-os/pipeline-runner at the top of the
 * file so every step export is a stub. Each test instantiates the
 * relevant runner with InMemoryFs, runs it (no orchestrator
 * needed -- run() is what emits the logs), and asserts the
 * required substrings appear in result.logs[].message.
 *
 * All 11 stage runners are now backed by real pipeline-runner
 * steps. Every step is mocked in the vi.mock block at the top of
 * this file. Each describe block instantiates its runner and asserts
 * the literal log-string the desktop helper deriveSteps() functions
 * pattern-match. If a runner silently changes its log-string, the
 * helper downgrades gracefully (toast counts go to zero) without any
 * compile-time signal -- this file is the safety net.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryFs } from "./_helpers/in-memory-fs.js";
import { makeManifest } from "./_helpers/manifest.js";

vi.mock("@founder-os/pipeline-runner", () => ({
  // Research: returns an outcomes array with three statuses so we can
  // assert "wrote " / "skipped " / "failed " all fire.
  createSaasResearchReportsStep: async () => ({
    status: "partial",
    outcomes: [
      { status: "written", spec: { filename: "ICP.md" }, path: "/v/01_research/saas/ICP.md" },
      {
        status: "skipped",
        spec: { filename: "Market.md" },
        path: "/v/01_research/saas/Market.md",
        reason: "exists",
      },
      {
        status: "failed",
        spec: { filename: "Pricing.md" },
        path: "/v/01_research/saas/Pricing.md",
        error: "stub",
      },
    ],
  }),
  // Brand: three steps, each returns minimal success.
  generateNamingCandidatesStep: async () => ({
    status: "done",
    scanPath: "/v/03_brand/names/scan.json",
    added: [{ name: "Lumencore" }],
    total: 1,
    note: "stub",
  }),
  createBrandBriefStep: async () => ({
    status: "done",
    brief: { name: "Lumencore", palette: {}, personality: [] },
  }),
  createLogoPackStep: async () => ({ status: "done" }),
  // Product: three deterministic steps. Status is whatever the runner
  // forwards verbatim into its log payload; "done" is fine.
  ensureBriefStep: async () => ({ status: "done" }),
  ensureSpecStep: async () => ({ status: "done" }),
  ensureScreensStep: async () => ({ status: "done" }),
  // UK setup: single step.
  ensureUkSetupStep: async () => ({ status: "done" }),
  // Audit: returns clean findings so the "audit step finished" log
  // fires (success path -- no critical/high flagged).
  auditVentureStep: async () => ({ findings: [], status: "done" }),
  // Stitch + Build: single step each. CoDesign added in slice 4 of
  // the dual-handoff arc -- HandoffStageRunner dispatches to one of
  // the two depending on manifest.handoffSource.
  createStitchPackStep: async () => ({ status: "done", producedArtifactIds: [] }),
  createCodesignPackStep: async () => ({ status: "done", producedArtifactIds: [] }),
  createBuildHandoffStep: async () => ({
    status: "done",
    bundle: { runId: "test-bundle", type: "build" },
  }),
  // Media: 4 steps. Each returns the minimal shape MediaStageRunner
  // reads. Real-step coverage lives in media-runner-real.test.ts.
  createMediaScriptStep: async () => ({
    status: "done",
    jsonPath: "v/10_media/scripts/media-script.json",
    mdPath: "v/10_media/scripts/media-script.md",
    generationSource: "deterministic",
    sources: [],
    script: {
      schemaVersion: 1, ventureSlug: "test", intent: "IDEA_TO_VIDEO",
      scenes: [{ id: "scene-1", durationSec: 5, voiceover: "v",
                 onScreen: "o", visualBrief: "b" }],
      generatedAt: "2026-05-07T00:00:00Z",
    },
  }),
  createStoryboardStep: async () => ({
    status: "done",
    jsonPath: "v/10_media/storyboards/storyboard.json",
    shotCount: 1,
    storyboard: {
      schemaVersion: 1, scriptId: "sb1", ventureSlug: "test",
      shots: [{ sceneId: "scene-1", engineHint: "hyperframes",
                prompt: "p", durationSec: 5 }],
      generatedAt: "2026-05-07T00:00:00Z",
    },
  }),
  createRenderShotsStep: async () => ({
    status: "done",
    rendersDir: "v/10_media/renders",
    shotCount: 1, successCount: 1, failureCount: 0, pendingFlowCount: 0,
    perShotResults: [
      { sceneId: "scene-1", status: "rendered", engine: "hyperframes",
        path: "v/10_media/renders/scene-1.mp4", durationSec: 5 },
    ],
  }),
  createStitchStep: async () => ({
    status: "done",
    reelPath: "v/10_media/exports/launch-reel.mp4",
    shotCount: 1,
  }),
  // Validation: real step now backs the runner. Returns a minimal
  // success result; the runner builds the artifact-index entries from
  // the result.jsonPath / result.mdPath fields and emits the literal
  // log message "validation checkpoint written" that this file pins.
  createValidationSummaryStep: async () => ({
    status: "done",
    jsonPath: "/v/02_validation/validation-summary.json",
    mdPath: "/v/02_validation/validation-summary.md",
    summary: {
      schemaVersion: 1,
      stage: "VALIDATION",
      runId: "stub",
      ventureId: "test-venture",
      ventureName: "Test Venture",
      createdAt: "2026-01-01T00:00:00Z",
      decision: "undecided",
      decisionReason: "",
      icp: { description: "", role: "", pain: "" },
      offer: { valueProposition: "", whatsIncluded: "", whatsExcluded: "" },
      pricing: { pricePoint: "", pricingModel: "" },
      experiments: { total: 0, done: 0, running: 0, planned: 0 },
      keyLearnings: "",
      whatChanged: "",
      musthaves: {
        icpDefined: false,
        offerDefined: false,
        pricingDecided: false,
        experimentRun: false,
        resultsDocumented: false,
        decisionMade: false,
        allMet: false,
      },
      sources: [],
      summarySource: "deterministic",
    },
  }),
  // Wireframe: real step now backs the runner. Returns a minimal
  // success result; the runner builds index entries from
  // result.jsonPath / result.mdPath and emits the literal log message
  // "wireframe checkpoint written" that this file pins.
  createWireframesStep: async () => ({
    status: "done",
    jsonPath: "/v/06_product/wireframes/wireframe-checkpoint.json",
    mdPath: "/v/06_product/wireframes/wireframes.md",
    checkpoint: {
      schemaVersion: 1,
      stage: "WIREFRAME",
      runId: "stub",
      ventureId: "test-venture",
      ventureName: "Test Venture",
      createdAt: "2026-01-01T00:00:00Z",
      derivedFrom: "/v/06_product/wireframes/screens-canvas.json",
      screens: [],
      summary: { totalScreens: 0, shellTypeCounts: {} },
      sources: ["screens-canvas.json"],
      generationSource: "deterministic",
    },
  }),
  // Finance: real step now backs the runner. Returns a minimal
  // success result; the runner indexes canvas + plan.json + plan.md
  // and emits the literal log message "ensure-finance-canvas finished"
  // that this file pins on BOTH the new-write and skip-if-exists paths.
  // Launch: real step now backs the runner. Returns a minimal
  // success result; the runner indexes receipt + announcement and
  // emits the literal log message "launch receipt written" that
  // this file pins.
  createLaunchPackageStep: async () => ({
    status: "done",
    receiptPath: "/v/08_launch/launch-receipt.json",
    announcementPath: "/v/08_launch/launch-announcement.md",
    receipt: {
      schemaVersion: 1,
      stage: "LAUNCH",
      runId: "stub",
      ventureId: "test-venture",
      ventureName: "Test Venture",
      ventureSlug: "test",
      launchedAt: "2026-01-01T00:00:00Z",
      status: "checkpoint",
      deploymentUrl: null,
      versionTag: null,
      buildRunId: null,
      brand: { name: null, tagline: null, targetAudience: null },
      validation: { decision: null, icp: null },
      pricing: { pricePoint: null, pricingModel: null, fundingRecommendation: null },
      ukSetup: { entityType: "ltd", hasUkSetupCanvas: false },
      build: { hasHandoff: false },
      preLaunchChecklist: [],
      sources: [],
      generationSource: "deterministic",
    },
  }),
  createFinancePlanStep: async () => ({
    status: "done",
    canvasStatus: "scaffolded",
    canvasPath: "/v/05_finance/finance-canvas.json",
    planJsonPath: "/v/05_finance/finance-plan.json",
    planMdPath: "/v/05_finance/finance-plan.md",
    canvas: {
      schemaVersion: 1,
      stage: "FINANCE",
      status: "checkpoint",
      runId: "stub",
      ventureId: "test-venture",
      createdAt: "2026-01-01T00:00:00Z",
      monthlyBudgetCapGBP: null,
      startingCapitalGBP: null,
      revenueModel: null,
      pricingTiers: [],
      costProjections: null,
      runwayMonths: null,
      note: "stub",
    },
    plan: {
      schemaVersion: 1,
      stage: "FINANCE",
      runId: "stub",
      ventureId: "test-venture",
      ventureName: "Test Venture",
      createdAt: "2026-01-01T00:00:00Z",
      inputs: {
        monthlyBudgetCapGBP: null,
        startingCapitalGBP: null,
        entityType: "ltd",
        takesPayments: false,
        regulated: false,
        handlesPersonalData: false,
        hiresStaff: false,
        pricePoint: null,
        pricingModel: null,
        validationDecision: null,
      },
      monthlyCosts: {
        infrastructureGBP: 100,
        paymentProcessingGBP: 0,
        complianceGBP: 0,
        staffingGBP: 0,
        otherGBP: 0,
        totalGBP: 100,
      },
      revenueAssumption: {
        monthlyPricePerCustomerGBP: null,
        targetCustomers12m: 50,
        projectedMrr12mGBP: null,
        rampMonths: 6,
      },
      runway: { months: null, breakEvenCustomers: null },
      fundingRecommendation: { path: "unclear", rationale: "stub" },
      assumptions: [],
      sources: ["finance-canvas.json"],
      generationSource: "deterministic",
    },
  }),
}));

const { ResearchStageRunner } = await import("../src/runners/research-runner.js");
const { BrandStageRunner } = await import("../src/runners/brand-runner.js");
const { ProductStageRunner } = await import("../src/runners/product-runner.js");
const { UkSetupStageRunner } = await import("../src/runners/uk-setup-runner.js");
const { AuditStageRunner } = await import("../src/runners/audit-runner.js");
const { StitchStageRunner } = await import("../src/runners/stitch-runner.js");
const { BuildStageRunner } = await import("../src/runners/build-runner.js");
const { ValidationStageRunner } = await import("../src/runners/validation-runner.js");
const { WireframeStageRunner } = await import("../src/runners/wireframe-runner.js");
const { FinanceStageRunner } = await import("../src/runners/finance-runner.js");
const { LaunchStageRunner } = await import("../src/runners/launch-runner.js");
const { MediaStageRunner } = await import("../src/runners/media-runner.js");

const noopLlm = async () => "stub";

function messages(logs: { message: string }[]): string[] {
  return logs.map((l) => l.message);
}

describe("ResearchStageRunner emits 'wrote'/'skipped'/'failed' prefixes per outcome", () => {
  it("each outcome status produces a log message starting with the helper-parsed prefix", async () => {
    const fs = new InMemoryFs();
    const runner = new ResearchStageRunner({
      manifest: makeManifest({ appType: "saas" }),
      ventureRoot: "/v",
      fs,
      intake: "Founder: ...",
      callLlm: noopLlm,
    });
    const result = await runner.run();
    const msgs = messages(result.logs);
    // run-research-stage.ts:deriveCounts looks for these prefixes.
    expect(msgs.some((m) => m.startsWith("wrote "))).toBe(true);
    expect(msgs.some((m) => m.startsWith("skipped "))).toBe(true);
    expect(msgs.some((m) => m.startsWith("failed "))).toBe(true);
  });
});

describe("BrandStageRunner emits 'X step finished' messages per step", () => {
  it("naming + brand-brief + logo-pack each emit the expected log", async () => {
    const fs = new InMemoryFs();
    const runner = new BrandStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      callLlm: noopLlm,
    });
    const result = await runner.run();
    const msgs = messages(result.logs);
    // run-brand-stage.ts:deriveSteps looks for these literal strings.
    expect(msgs).toContain("naming step finished");
    expect(msgs).toContain("brand-brief step finished");
    expect(msgs).toContain("logo-pack step finished");
  });
});

describe("ProductStageRunner emits 'ensure-X finished' messages per step", () => {
  it("ensure-brief + ensure-spec + ensure-screens each emit the expected log", async () => {
    const fs = new InMemoryFs();
    const runner = new ProductStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
    });
    const result = await runner.run();
    const msgs = messages(result.logs);
    // run-product-stage.ts:deriveSteps looks for these literal strings.
    expect(msgs).toContain("ensure-brief finished");
    expect(msgs).toContain("ensure-spec finished");
    expect(msgs).toContain("ensure-screens finished");
  });
});

describe("UkSetupStageRunner emits 'ensure-uk-setup finished'", () => {
  it("the helper-parsed string appears in logs on success", async () => {
    const fs = new InMemoryFs();
    const runner = new UkSetupStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
    });
    const result = await runner.run();
    expect(messages(result.logs)).toContain("ensure-uk-setup finished");
  });
});

describe("AuditStageRunner emits 'audit step finished'", () => {
  it("the helper-parsed string appears in logs on success", async () => {
    const fs = new InMemoryFs();
    const runner = new AuditStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
    });
    const result = await runner.run();
    expect(messages(result.logs)).toContain("audit step finished");
  });
});

describe("HandoffStageRunner (Stitch path) emits 'create-stitch-pack finished'", () => {
  it("the helper-parsed string appears in logs on success", async () => {
    const fs = new InMemoryFs();
    // Stitch's validate() checks brand-brief.json exists; we don't
    // exercise validate() here -- just run() -- but writing the file
    // matches the precondition for completeness.
    fs.files.set("v/03_brand/brand-kit/brand-brief.json", "{}");
    const runner = new StitchStageRunner({
      manifest: makeManifest({ handoffSource: "stitch" }),
      ventureRoot: "/v",
      fs,
    });
    const result = await runner.run();
    expect(messages(result.logs)).toContain("create-stitch-pack finished");
  });
});

describe("HandoffStageRunner (CoDesign path) emits 'create-codesign-pack finished'", () => {
  it("default provider is codesign and the helper-parsed string appears in logs", async () => {
    const fs = new InMemoryFs();
    fs.files.set("v/03_brand/brand-kit/brand-brief.json", "{}");
    // No handoffSource override -- the runner defaults to "codesign".
    const runner = new StitchStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
    });
    const result = await runner.run();
    expect(messages(result.logs)).toContain("create-codesign-pack finished");
  });
});

describe("HandoffStageRunner emits 'HANDOFF stage starting' on every run", () => {
  it("the start-message fires regardless of provider so spinner state can key on it", async () => {
    // Stitch path
    const fsStitch = new InMemoryFs();
    fsStitch.files.set("v/03_brand/brand-kit/brand-brief.json", "{}");
    const stitchRunner = new StitchStageRunner({
      manifest: makeManifest({ handoffSource: "stitch" }),
      ventureRoot: "/v",
      fs: fsStitch,
    });
    const stitchResult = await stitchRunner.run();
    expect(messages(stitchResult.logs)).toContain("HANDOFF stage starting");

    // CoDesign path (default)
    const fsCodesign = new InMemoryFs();
    fsCodesign.files.set("v/03_brand/brand-kit/brand-brief.json", "{}");
    const codesignRunner = new StitchStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs: fsCodesign,
    });
    const codesignResult = await codesignRunner.run();
    expect(messages(codesignResult.logs)).toContain("HANDOFF stage starting");
  });
});

describe("BuildStageRunner emits 'create-build-handoff finished'", () => {
  it("the helper-parsed string appears in logs on success", async () => {
    const fs = new InMemoryFs();
    // Pre-write brand-brief.json -- the runner reads it via readFile
    // before invoking the stubbed step.
    fs.files.set("v/03_brand/brand-kit/brand-brief.json", JSON.stringify({ name: "Test" }));
    const runner = new BuildStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
    });
    const result = await runner.run();
    expect(messages(result.logs)).toContain("create-build-handoff finished");
  });
});

describe("ValidationStageRunner emits 'validation checkpoint written'", () => {
  it("the helper-parsed string appears in logs on success", async () => {
    const fs = new InMemoryFs();
    const runner = new ValidationStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
    });
    const result = await runner.run();
    // run-validation-stage.ts:deriveSteps looks for this literal string.
    expect(messages(result.logs)).toContain("validation checkpoint written");
  });
});

describe("WireframeStageRunner emits 'wireframe checkpoint written'", () => {
  it("the helper-parsed string appears in logs on success", async () => {
    const fs = new InMemoryFs();
    // The runner does NOT re-check the screens-canvas prereq inside
    // run() -- validate() guards that path -- so we can call run()
    // directly here and assert the checkpoint log fires.
    const runner = new WireframeStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
    });
    const result = await runner.run();
    // run-wireframe-stage.ts:deriveSteps looks for this literal string.
    expect(messages(result.logs)).toContain("wireframe checkpoint written");
  });
});

describe("FinanceStageRunner emits 'ensure-finance-canvas finished'", () => {
  it("the helper-parsed string appears in logs on the new-write path", async () => {
    const fs = new InMemoryFs();
    const runner = new FinanceStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
    });
    const result = await runner.run();
    // run-finance-stage.ts:deriveSteps looks for this literal string.
    // The runner emits this on BOTH the new-write and skip-if-exists
    // paths, so the helper resolves to "ok" either way.
    expect(messages(result.logs)).toContain("ensure-finance-canvas finished");
  });

  it("also fires on the skip-if-exists path", async () => {
    const fs = new InMemoryFs();
    fs.files.set("v/05_finance/finance-canvas.json", "{}");
    const runner = new FinanceStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
    });
    const result = await runner.run();
    expect(messages(result.logs)).toContain("ensure-finance-canvas finished");
  });
});

describe("LaunchStageRunner emits 'launch receipt written'", () => {
  it("the helper-parsed string appears in logs on success", async () => {
    const fs = new InMemoryFs();
    const runner = new LaunchStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
    });
    const result = await runner.run();
    // run-launch-stage.ts:deriveSteps looks for this literal string.
    expect(messages(result.logs)).toContain("launch receipt written");
  });
});

describe("MediaStageRunner emits 5 drift-protected log strings on full success", () => {
  it("MEDIA stage starting / media script written / storyboard written / render-shots finished / launch reel stitched", async () => {
    const fs = new InMemoryFs();
    const runner = new MediaStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
    });
    const result = await runner.run();
    const msgs = messages(result.logs);
    // run-media-stage.ts:deriveSteps (when the helper lands in the
    // desktop adoption slice) will pattern-match these 5 literal
    // strings to derive per-step status. Drift here would silently
    // collapse the desktop toast counts to zero.
    expect(msgs).toContain("MEDIA stage starting");
    expect(msgs).toContain("media script written");
    expect(msgs).toContain("storyboard written");
    expect(msgs).toContain("render-shots finished");
    expect(msgs).toContain("launch reel stitched");
  });
});
