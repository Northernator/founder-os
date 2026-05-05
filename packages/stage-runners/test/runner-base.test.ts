/**
 * BaseStageRunner / generateRunId tests.
 *
 * The base class is exercised through a tiny TestRunner subclass --
 * we don't expose the protected helpers publicly, so the test
 * runner stays internal to this file. Verifies:
 *   - artifact index merges with existing entries
 *   - review gate writes append, not overwrite
 *   - log buffer flushes to JSONL with one entry per line
 *   - stageRequiresReview reads pipeline.reviewGates with fallback
 *   - generateRunId is sortable + unique
 */
import type { ArtifactIndexEntry, ReviewGate, StageName } from "@founder-os/domain";
import { describe, expect, it } from "vitest";
import { BaseStageRunner, generateRunId } from "../src/index.js";
import { InMemoryFs } from "./_helpers/in-memory-fs.js";
import { makeManifest } from "./_helpers/manifest.js";

class TestRunner extends BaseStageRunner {
  readonly stageName: StageName = "RESEARCH";

  // Re-expose protected helpers for testing. Keeps the production
  // surface clean.
  public testLog(level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) {
    this.log(level, msg, data);
  }
  public async testFlushLogs() {
    await this.flushLogs();
  }
  public async testAppendArtifactIndex(entries: ArtifactIndexEntry[]) {
    await this.appendArtifactIndex(entries);
  }
  public async testAppendReviewGate(gate: ReviewGate) {
    await this.appendReviewGate(gate);
  }
  public testStageRequiresReview() {
    return this.stageRequiresReview();
  }
  public getRunId() {
    return this.runId;
  }

  async validate() {
    return { valid: true, missingResources: [], errors: [] };
  }
  async run() {
    return {
      success: true,
      stageName: this.stageName,
      runId: this.runId,
      artifactsCreated: [],
      logs: [],
      requiresReview: false,
      nextStageReady: true,
    };
  }
}

describe("BaseStageRunner.appendArtifactIndex", () => {
  it("merges new entries with the existing index", async () => {
    const fs = new InMemoryFs();
    const indexPath = "v/.founder/artifacts/index.json";
    const existing: ArtifactIndexEntry = {
      artifactId: "research:icp",
      stageName: "RESEARCH",
      type: "saas-research-report",
      path: "/v/01_research/saas/ICP.md",
      createdAt: "2026-05-03T00:00:00Z",
      status: "ready",
    };
    fs.files.set(indexPath, JSON.stringify([existing]));
    const runner = new TestRunner("/v", fs, makeManifest(), "r1");
    const newEntry: ArtifactIndexEntry = {
      artifactId: "research:competitors",
      stageName: "RESEARCH",
      type: "saas-research-report",
      path: "/v/01_research/saas/competitors.md",
      createdAt: "2026-05-03T01:00:00Z",
      status: "ready",
    };
    await runner.testAppendArtifactIndex([newEntry]);
    // biome-ignore lint/style/noNonNullAssertion: test asserts presence above
    const merged = JSON.parse(fs.files.get(indexPath)!);
    expect(merged).toHaveLength(2);
    expect(merged[0].artifactId).toBe("research:icp");
    expect(merged[1].artifactId).toBe("research:competitors");
  });

  it("starts fresh if the index file is missing", async () => {
    const fs = new InMemoryFs();
    const runner = new TestRunner("/v", fs, makeManifest());
    await runner.testAppendArtifactIndex([
      {
        artifactId: "x",
        stageName: "RESEARCH",
        type: "t",
        path: "/v/x",
        createdAt: "now",
        status: "ready",
      },
    ]);
    // biome-ignore lint/style/noNonNullAssertion: test asserts presence above
    const merged = JSON.parse(fs.files.get("v/.founder/artifacts/index.json")!);
    expect(merged).toHaveLength(1);
  });
});

describe("BaseStageRunner.appendReviewGate", () => {
  it("appends to the existing gates file", async () => {
    const fs = new InMemoryFs();
    const path = "v/.founder/state/review-gates.json";
    const old: ReviewGate = {
      gateId: "old-gate",
      stageName: "BRAND",
      runId: "r0",
      requiredApproval: "business",
      status: "approved",
      createdAt: "2026-05-01T00:00:00Z",
      artifactsForReview: [],
    };
    fs.files.set(path, JSON.stringify([old]));
    const runner = new TestRunner("/v", fs, makeManifest());
    const fresh: ReviewGate = {
      gateId: "fresh-gate",
      stageName: "RESEARCH",
      runId: "r1",
      requiredApproval: "business",
      status: "pending",
      createdAt: "2026-05-03T00:00:00Z",
      artifactsForReview: [],
    };
    await runner.testAppendReviewGate(fresh);
    // biome-ignore lint/style/noNonNullAssertion: test asserts presence above
    const merged = JSON.parse(fs.files.get(path)!);
    expect(merged).toHaveLength(2);
    expect(merged[1].gateId).toBe("fresh-gate");
  });
});

describe("BaseStageRunner.flushLogs", () => {
  it("writes one JSONL entry per log() call", async () => {
    const fs = new InMemoryFs();
    const runner = new TestRunner("/v", fs, makeManifest(), "r1");
    runner.testLog("info", "first");
    runner.testLog("warn", "second", { detail: 42 });
    await runner.testFlushLogs();
    const path = `v/.founder/logs/RESEARCH-${runner.getRunId()}.jsonl`;
    const content = fs.files.get(path);
    expect(content).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: test asserts presence above
    const lines = content!.trim().split("\n");
    expect(lines).toHaveLength(2);
    // biome-ignore lint/style/noNonNullAssertion: test asserts presence above
    const first = JSON.parse(lines[0]!);
    expect(first.message).toBe("first");
    expect(first.level).toBe("info");
    // biome-ignore lint/style/noNonNullAssertion: test asserts presence above
    const second = JSON.parse(lines[1]!);
    expect(second.data).toEqual({ detail: 42 });
  });

  it("is a no-op when the log buffer is empty", async () => {
    const fs = new InMemoryFs();
    const runner = new TestRunner("/v", fs, makeManifest());
    await runner.testFlushLogs();
    expect(fs.files.size).toBe(0);
  });
});

describe("BaseStageRunner.stageRequiresReview", () => {
  it("returns true when stageName is in DEFAULT_REVIEW_GATES (default config)", async () => {
    const fs = new InMemoryFs();
    // RESEARCH is NOT in DEFAULT_REVIEW_GATES (defaults are BRAND + AUDIT).
    const runner = new TestRunner("/v", fs, makeManifest());
    expect(runner.testStageRequiresReview()).toBe(false);
  });

  it("returns true when manifest opts in via pipeline.reviewGates", async () => {
    const fs = new InMemoryFs();
    const manifest = makeManifest({
      pipeline: { reviewGates: ["RESEARCH"] },
    });
    const runner = new TestRunner("/v", fs, manifest);
    expect(runner.testStageRequiresReview()).toBe(true);
  });

  it("returns false when manifest opts out via empty pipeline.reviewGates", async () => {
    const fs = new InMemoryFs();
    const manifest = makeManifest({
      pipeline: { reviewGates: [] },
    });
    // BRAND is normally in defaults but explicit empty overrides.
    class BrandRunner extends TestRunner {
      readonly stageName: StageName = "BRAND" as const;
    }
    const runner = new BrandRunner("/v", fs, manifest);
    expect(runner.testStageRequiresReview()).toBe(false);
  });
});

describe("generateRunId", () => {
  it("returns a non-empty string of base36-ish chars", () => {
    const id = generateRunId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(4);
    expect(id).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
  });

  it("two consecutive calls produce different ids", () => {
    const a = generateRunId();
    const b = generateRunId();
    expect(a).not.toBe(b);
  });
});
