/**
 * CrmStageRunner contract tests.
 *
 * Pins the contract that survives slice 4's promotion from skeletal to
 * real-step orchestration: validate(), checkpoint shape, idempotency,
 * review-gate emission, log strings.
 *
 * Real-step provider integration (config_only happy path, Docker
 * fallthrough, pre-provision + pre-send gates) lives in
 * crm-runner-real.test.ts -- a future addition once we mock the
 * underlying providers in finer detail.
 */
import { describe, expect, it } from "vitest";

import type { CrmEngine, CrmProvider } from "@founder-os/crm-core";
import {
  getCrmCheckpointPath,
  getCrmConfigPath,
  getCrmInstancePath,
  getReviewGatesPath,
} from "@founder-os/workspace-core";

import { CrmStageRunner } from "../src/runners/crm-runner.js";
import { InMemoryFs } from "./_helpers/in-memory-fs.js";
import { makeManifest } from "./_helpers/manifest.js";

const VENTURE_ROOT = "/ventures/test";

const FIXED_NOW = new Date("2026-05-12T10:00:00.000Z");

function makeStubProvider(): CrmProvider {
  return {
    name: "config_only" as const,
    async available() {
      return true;
    },
    async provision({ ventureSlug, adminEmail }) {
      return {
        ventureSlug,
        engine: "config_only",
        adminEmail,
        provisionedAt: FIXED_NOW.toISOString(),
      };
    },
    async upsertSegments() {},
    async upsertContacts() {},
    async upsertOpportunities() {},
    async upsertTemplates() {},
    async createCampaign(c) {
      return { id: c.id };
    },
  };
}

function makeRunner(overrides: Partial<Parameters<typeof makeManifest>[0]> = {}) {
  const fs = new InMemoryFs();
  const manifest = makeManifest(overrides);
  const providers: Partial<Record<CrmEngine, CrmProvider>> = {
    config_only: makeStubProvider(),
  };
  const runner = new CrmStageRunner({
    manifest,
    ventureRoot: VENTURE_ROOT,
    fs,
    providers,
    now: () => FIXED_NOW,
    runId: "fixed-run-id",
  });
  return { runner, fs, manifest };
}

describe("CrmStageRunner.validate()", () => {
  it("passes for a well-formed manifest", async () => {
    const { runner } = makeRunner();
    const result = await runner.validate();
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("reports missing manifest.id", async () => {
    const { runner } = makeRunner({ id: "" });
    const result = await runner.validate();
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("manifest.id is required for CRM stage");
  });

  it("reports missing manifest.name", async () => {
    const { runner } = makeRunner({ name: "" });
    const result = await runner.validate();
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("manifest.name is required for CRM stage");
  });
});

describe("CrmStageRunner.run() -- happy path with config_only", () => {
  it("writes crm-checkpoint.json under 11_crm/", async () => {
    const { runner, fs } = makeRunner();
    const result = await runner.run();
    expect(result.success).toBe(true);
    expect(result.stageName).toBe("CRM");
    const checkpointPath = getCrmCheckpointPath(VENTURE_ROOT);
    expect(fs.files.has(checkpointPath)).toBe(true);

    const raw = fs.files.get(checkpointPath);
    expect(raw).toBeDefined();
    const checkpoint = JSON.parse(raw ?? "{}");
    expect(checkpoint.status).toBe("completed");
    expect(checkpoint.ventureSlug).toBe("test");
    expect(checkpoint.runId).toBe("fixed-run-id");
    expect(checkpoint.instance.engine).toBe("config_only");
  });

  it("writes crm-instance.json and crm-config.json", async () => {
    const { runner, fs } = makeRunner();
    await runner.run();
    expect(fs.files.has(getCrmInstancePath(VENTURE_ROOT))).toBe(true);
    expect(fs.files.has(getCrmConfigPath(VENTURE_ROOT))).toBe(true);
  });

  it("emits the expected log strings (drift protection)", async () => {
    const { runner } = makeRunner();
    const result = await runner.run();
    const messages = result.logs.map((l) => l.message);
    expect(messages).toContain("CRM stage starting");
    expect(messages).toContain("crm: provisioned");
    expect(messages).toContain("crm: seeded");
    expect(messages).toContain("crm: campaign created");
    expect(messages).toContain("crm: checkpoint written");
  });

  it("emits a pre-send review gate even when CRM is not in pipeline.reviewGates", async () => {
    // The runner always emits a pre-send gate because the launch campaign
    // is created (autoSend=false) -- the founder needs to approve.
    const { runner, fs } = makeRunner();
    const result = await runner.run();
    expect(result.requiresReview).toBe(true);
    expect(result.reviewGateId).toBeDefined();
    expect(fs.files.has(getReviewGatesPath(VENTURE_ROOT))).toBe(true);
  });

  it("returns failed when no provider is available", async () => {
    const fs = new InMemoryFs();
    const runner = new CrmStageRunner({
      manifest: makeManifest(),
      ventureRoot: VENTURE_ROOT,
      fs,
      providers: {}, // empty -- resolver finds nothing
      now: () => FIXED_NOW,
      runId: "fixed-run-id",
    });
    const result = await runner.run();
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("CRM_STEP_THREW");
  });
});
