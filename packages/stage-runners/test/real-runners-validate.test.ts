/**
 * Validate-only tests for the seven LLM-or-step-backed runners.
 *
 * The run() bodies of these runners call into @founder-os/pipeline-runner
 * steps that need real inputs (LLM caller, etc) -- those are tested
 * by their own packages + the smoke harness. Here we just lock in
 * each runner's validate() contract: required manifest fields,
 * prereq files, and any LLM-caller checks.
 *
 * Why this matters: validate() is the runner's "preflight" surface
 * the orchestrator depends on. A regression that silently weakens a
 * check would let invalid inputs through and surface as confusing
 * step-level errors downstream.
 */
import { describe, expect, it } from "vitest";
import {
  AuditStageRunner,
  BrandStageRunner,
  BuildStageRunner,
  ProductStageRunner,
  ResearchStageRunner,
  StitchStageRunner,
  UkSetupStageRunner,
} from "../src/index.js";
import { InMemoryFs } from "./_helpers/in-memory-fs.js";
import { makeManifest } from "./_helpers/manifest.js";

const noopLlm = async () => "stub";

describe("ResearchStageRunner.validate()", () => {
  it("rejects non-saas appType", async () => {
    const fs = new InMemoryFs();
    const runner = new ResearchStageRunner({
      manifest: makeManifest({ appType: "web" }),
      ventureRoot: "/v",
      fs,
      intake: "transcript",
      callLlm: noopLlm,
    });
    const r = await runner.validate();
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toContain('appType === "saas"');
  });

  it("rejects empty intake transcript", async () => {
    const fs = new InMemoryFs();
    const runner = new ResearchStageRunner({
      manifest: makeManifest({ appType: "saas" }),
      ventureRoot: "/v",
      fs,
      intake: "   ",
      callLlm: noopLlm,
    });
    const r = await runner.validate();
    expect(r.valid).toBe(false);
    expect(r.missingResources).toContain("intake transcript");
  });

  it("accepts a saas manifest with intake + callLlm", async () => {
    const fs = new InMemoryFs();
    const runner = new ResearchStageRunner({
      manifest: makeManifest({ appType: "saas" }),
      ventureRoot: "/v",
      fs,
      intake: "Founder: We are building...",
      callLlm: noopLlm,
    });
    const r = await runner.validate();
    expect(r.valid).toBe(true);
  });
});

describe("BrandStageRunner.validate()", () => {
  it("requires manifest.name and manifest.slug", async () => {
    const fs = new InMemoryFs();
    const runner = new BrandStageRunner({
      manifest: makeManifest({ name: "", slug: "" }),
      ventureRoot: "/v",
      fs,
      callLlm: noopLlm,
    });
    const r = await runner.validate();
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("accepts a complete manifest", async () => {
    const fs = new InMemoryFs();
    const runner = new BrandStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      callLlm: noopLlm,
    });
    const r = await runner.validate();
    expect(r.valid).toBe(true);
  });
});

describe("ProductStageRunner.validate()", () => {
  it("requires id, name, appType", async () => {
    const fs = new InMemoryFs();
    const runner = new ProductStageRunner({
      manifest: makeManifest({ id: "", name: "", appType: "" as never }),
      ventureRoot: "/v",
      fs,
    });
    const r = await runner.validate();
    expect(r.valid).toBe(false);
  });
});

describe("UkSetupStageRunner.validate()", () => {
  it("requires manifest.id and manifest.entityType", async () => {
    const fs = new InMemoryFs();
    const runner = new UkSetupStageRunner({
      manifest: makeManifest({ id: "" }),
      ventureRoot: "/v",
      fs,
    });
    const r = await runner.validate();
    expect(r.valid).toBe(false);
  });
});

describe("AuditStageRunner.validate()", () => {
  it("requires manifest.id", async () => {
    const fs = new InMemoryFs();
    const runner = new AuditStageRunner({
      manifest: makeManifest({ id: "" }),
      ventureRoot: "/v",
      fs,
    });
    const r = await runner.validate();
    expect(r.valid).toBe(false);
  });
});

describe("StitchStageRunner.validate()", () => {
  it("rejects when brand-brief.json is missing", async () => {
    const fs = new InMemoryFs();
    const runner = new StitchStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
    });
    const r = await runner.validate();
    expect(r.valid).toBe(false);
    expect(r.missingResources.join(" ")).toContain("brand-brief.json");
  });
});

describe("BuildStageRunner.validate()", () => {
  it("rejects when stitch / spec / brand prereqs are missing", async () => {
    const fs = new InMemoryFs();
    const runner = new BuildStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
    });
    const r = await runner.validate();
    expect(r.valid).toBe(false);
    expect(r.missingResources.length).toBeGreaterThanOrEqual(1);
  });
});
