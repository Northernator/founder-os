/**
 * HandoffPackStageRunner -- real-path tests.
 *
 * Slice 5 of the handoff-pack arc promoted the runner from a
 * self-contained skeletal placeholder to an orchestrator wrapping
 * `renderHandoffPackArtefactsStep` from
 * @founder-os/handoff-pack-providers/node. These tests mock that
 * single orchestration step so the runner test does not pull in
 * pdf-engine internals, node:fs/promises, or the 206-entry template
 * walk; they exercise:
 *
 *   1. validate() blocks when BRAND has not shipped (no
 *      brand-brief.json on disk).
 *   2. Success path: 3 artifacts indexed (INDEX.md + inventory JSON +
 *      checkpoint), checkpoint matches HandoffPackCheckpointSchema,
 *      INDEX.md surfaces the rendered counts.
 *   3. INDEX.md content carries the venture name + tier breakdown +
 *      generated-at timestamp.
 *   4. Inventory JSON parses through HandoffPackInventorySchema.
 *   5. Failure -> success path: a partial walk (some failures) lands
 *      as status:"completed" when at least one PDF rendered.
 *   6. All-failures path: status flips to "failed" when nothing
 *      rendered AND there were errors.
 *   7. Review-gate creation when HANDOFF_PACK is in
 *      pipeline.reviewGates.
 *   8. Brand-missing thrown by the orchestrator -> failureCode
 *      "HANDOFF_PACK_BRAND_MISSING".
 *
 * Mirrors media-runner-real / crm-runner / backend-runner tests.
 */
import { describe, expect, it, vi } from "vitest";
import {
  HandoffPackCheckpointSchema,
  HandoffPackInventorySchema,
  type Role,
} from "@founder-os/handoff-pack-core";
import { DOC_MANIFEST_COUNT } from "@founder-os/handoff-pack-core/manifest";
import {
  getBrandKitDir,
  getHandoffPackCheckpointPath,
  getHandoffPackDir,
  getHandoffPackIndexPath,
  getReviewGatesPath,
} from "@founder-os/workspace-core";
import { InMemoryFs } from "./_helpers/in-memory-fs.js";
import { makeManifest } from "./_helpers/manifest.js";

const orchestratorSpy = vi.fn();

vi.mock("@founder-os/handoff-pack-providers/node", () => ({
  renderHandoffPackArtefactsStep: (opts: unknown) => orchestratorSpy(opts),
}));

const { HandoffPackStageRunner } = await import("../src/runners/handoff-pack-runner.js");

const VENTURE = "/v";
const ROLES: Role[] = [
  "founder",
  "dev",
  "designer",
  "marketing",
  "sales",
  "support",
  "finance",
  "contractor",
];

function brandShipped(fs: InMemoryFs): void {
  fs.files.set(`${getBrandKitDir(VENTURE)}/brand-brief.json`, "{}");
}

function fakeArtefacts(opts: {
  generated?: number;
  partial?: number;
  stub?: number;
  failed?: number;
  pending?: number;
  ventureName?: string;
  ventureSlug?: string;
  inventoryMarkdown?: string;
  rolePacksGenerated?: number;
} = {}) {
  const generated = opts.generated ?? 1;
  const partial = opts.partial ?? 0;
  const stub = opts.stub ?? 0;
  const failed = opts.failed ?? 0;
  const pending = opts.pending ?? 0;
  const total = generated + partial + stub + failed + pending;
  const entries: Array<{
    docId: string;
    category: "00-company-control";
    slot: string;
    title: string;
    tier: "A" | "D";
    status: "generated" | "stub" | "failed";
    pdfRelativePath: string;
    lastRenderedAt?: string;
    failureReason?: string;
  }> = [];
  for (let i = 0; i < generated; i++) {
    entries.push({
      docId: `g${i}`,
      category: "00-company-control",
      slot: String(i).padStart(2, "0"),
      title: `Generated ${i}`,
      tier: "A",
      status: "generated",
      pdfRelativePath: `company-control/g${i}.pdf`,
      lastRenderedAt: "2026-05-17T00:00:00.000Z",
    });
  }
  for (let i = 0; i < stub; i++) {
    entries.push({
      docId: `s${i}`,
      category: "00-company-control",
      slot: String(50 + i).padStart(2, "0"),
      title: `Stub ${i}`,
      tier: "D",
      status: "stub",
      pdfRelativePath: `company-control/s${i}.pdf`,
      lastRenderedAt: "2026-05-17T00:00:00.000Z",
    });
  }
  for (let i = 0; i < failed; i++) {
    entries.push({
      docId: `f${i}`,
      category: "00-company-control",
      slot: String(80 + i).padStart(2, "0"),
      title: `Failed ${i}`,
      tier: "A",
      status: "failed",
      pdfRelativePath: `company-control/f${i}.pdf`,
      failureReason: "stub: forced failure for test",
    });
  }
  const rolePacksGenerated = opts.rolePacksGenerated ?? 8;
  const rolePacks = Object.fromEntries(
    ROLES.map((role, i) => [
      role,
      i < rolePacksGenerated ? "generated" : "skipped",
    ]),
  ) as Record<Role, "generated" | "skipped" | "failed">;
  const rolePackResults = ROLES.slice(0, rolePacksGenerated).map((role) => ({
    role,
    title: `${role} Pack`,
    pdfPath: `${getHandoffPackDir(VENTURE)}/role-packs/${role}-pack.pdf`,
    status: "generated" as const,
    bytesWritten: 512,
    docsIncluded: 1,
    docsUnavailable: 0,
    renderedAt: "2026-05-17T00:00:00.000Z",
  }));
  return {
    brand: {
      brandDir: `${getHandoffPackDir(VENTURE)}/.brand`,
      tokens: {} as unknown,
      config: {} as unknown,
      logoCopied: false,
      notes: ["brand: stubbed for test"],
    },
    inventory: {
      generatedAt: "2026-05-17T00:00:00.000Z",
      ventureSlug: opts.ventureSlug ?? "test",
      ventureName: opts.ventureName ?? "Test Venture",
      totalDocs: total,
      entries,
      rolePacks,
    },
    inventoryMarkdown:
      opts.inventoryMarkdown ??
      `# Handoff pack -- ${opts.ventureName ?? "Test Venture"}\n\n- Generated ${generated}\n- Stubs ${stub}\n- Failed ${failed}\n`,
    walk: {
      entries,
      counts: { generated, partial, stub, manual: 0, failed, pending },
      notes: failed > 0 ? [`failed: f0 -- stub`] : [],
    },
    notes: ["brand: stubbed for test"],
    rolePacks: {
      rolePacks,
      results: rolePackResults,
      counts: {
        generated: rolePacksGenerated,
        skipped: ROLES.length - rolePacksGenerated,
        failed: 0,
      },
      notes: [`role-packs: generated=${rolePacksGenerated}`],
    },
  };
}

describe("HandoffPackStageRunner -- validate", () => {
  it("blocks when BRAND has not shipped (no brand-brief.json on disk)", async () => {
    const fs = new InMemoryFs();
    const runner = new HandoffPackStageRunner({
      manifest: makeManifest(),
      ventureRoot: VENTURE,
      fs,
    });
    const result = await runner.validate();
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("BRAND has not shipped"))).toBe(true);
    expect(result.missingResources.some((p) => p.endsWith("brand-brief.json"))).toBe(true);
  });

  it("passes when manifest is complete AND brand-brief.json exists", async () => {
    const fs = new InMemoryFs();
    brandShipped(fs);
    const runner = new HandoffPackStageRunner({
      manifest: makeManifest(),
      ventureRoot: VENTURE,
      fs,
    });
    const result = await runner.validate();
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("collects manifest.id + manifest.name errors alongside the brand check", async () => {
    const fs = new InMemoryFs();
    const runner = new HandoffPackStageRunner({
      manifest: makeManifest({ id: "", name: "" }),
      ventureRoot: VENTURE,
      fs,
    });
    const result = await runner.validate();
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("manifest.id"))).toBe(true);
    expect(result.errors.some((e) => e.includes("manifest.name"))).toBe(true);
    expect(result.errors.some((e) => e.includes("BRAND"))).toBe(true);
  });
});

describe("HandoffPackStageRunner -- success path", () => {
  it("indexes inventory + checkpoint + role packs and emits all 4 drift-protected log strings", async () => {
    orchestratorSpy.mockReset().mockResolvedValue(fakeArtefacts({ generated: 5, stub: 7 }));
    const fs = new InMemoryFs();
    brandShipped(fs);
    const runner = new HandoffPackStageRunner({
      manifest: makeManifest(),
      ventureRoot: VENTURE,
      fs,
    });
    const result = await runner.run();
    expect(result.success).toBe(true);
    expect(result.artifactsCreated).toHaveLength(11);

    const msgs = result.logs.map((l) => l.message);
    expect(msgs).toContain("HANDOFF_PACK stage starting");
    expect(msgs).toContain("Preparing brand assets in 13_handoff_pack/.brand/");
    expect(msgs).toContain("Rendered 12 PDFs into 13_handoff_pack/");
    expect(msgs).toContain("Rendered 8 role packs into 13_handoff_pack/role-packs/");
    expect(msgs).toContain("Wrote inventory to 13_handoff_pack/INDEX.md");

    // Inventory/checkpoint artifacts at the path helpers' resolved positions.
    expect(fs.files.has(getHandoffPackIndexPath(VENTURE))).toBe(true);
    expect(fs.files.has(getHandoffPackCheckpointPath(VENTURE))).toBe(true);
    expect(fs.files.has(`${getHandoffPackDir(VENTURE)}/handoff-pack-inventory.json`)).toBe(true);
  });

  it("writes a checkpoint that parses through HandoffPackCheckpointSchema with real counts", async () => {
    orchestratorSpy.mockReset().mockResolvedValue(fakeArtefacts({ generated: 3, partial: 2, stub: 1 }));
    const fs = new InMemoryFs();
    brandShipped(fs);
    const runner = new HandoffPackStageRunner({
      manifest: makeManifest(),
      ventureRoot: VENTURE,
      fs,
    });
    const result = await runner.run();
    expect(result.success).toBe(true);

    const raw = fs.files.get(getHandoffPackCheckpointPath(VENTURE));
    expect(raw).toBeDefined();
    const parsed = HandoffPackCheckpointSchema.parse(JSON.parse(raw!));
    expect(parsed.runId).toBe(result.runId);
    expect(parsed.status).toBe("completed");
    expect(parsed.docsRendered).toBe(3);
    expect(parsed.docsPartial).toBe(2);
    expect(parsed.docsStubbed).toBe(1);
    expect(parsed.docsFailed).toBe(0);
    expect(parsed.rolePacksGenerated).toBe(8);
    expect(parsed.inventoryPath).toBe(getHandoffPackIndexPath(VENTURE));
  });

  it("INDEX.md carries the venture name + the orchestrator-supplied body", async () => {
    orchestratorSpy.mockReset().mockResolvedValue(
      fakeArtefacts({
        ventureName: "Acme Inc",
        inventoryMarkdown: "# Handoff pack -- Acme Inc\n\nGenerated rows: 1\n",
      }),
    );
    const fs = new InMemoryFs();
    brandShipped(fs);
    const runner = new HandoffPackStageRunner({
      manifest: makeManifest({ name: "Acme Inc" }),
      ventureRoot: VENTURE,
      fs,
    });
    const result = await runner.run();
    expect(result.success).toBe(true);
    const body = fs.files.get(getHandoffPackIndexPath(VENTURE)) ?? "";
    expect(body).toContain("Handoff pack -- Acme Inc");
    expect(body).toContain("Generated rows: 1");
  });

  it("inventory JSON parses through HandoffPackInventorySchema", async () => {
    orchestratorSpy.mockReset().mockResolvedValue(fakeArtefacts({ generated: 2 }));
    const fs = new InMemoryFs();
    brandShipped(fs);
    const runner = new HandoffPackStageRunner({
      manifest: makeManifest(),
      ventureRoot: VENTURE,
      fs,
    });
    const result = await runner.run();
    expect(result.success).toBe(true);
    const raw = fs.files.get(`${getHandoffPackDir(VENTURE)}/handoff-pack-inventory.json`);
    expect(raw).toBeDefined();
    const inv = HandoffPackInventorySchema.parse(JSON.parse(raw!));
    expect(inv.totalDocs).toBe(2);
    expect(inv.entries).toHaveLength(2);
    expect(inv.entries[0]!.status).toBe("generated");
    expect(inv.rolePacks.founder).toBe("generated");
  });

  it("forwards manifest fields into the orchestration step", async () => {
    orchestratorSpy.mockReset().mockResolvedValue(fakeArtefacts());
    const fs = new InMemoryFs();
    brandShipped(fs);
    const runner = new HandoffPackStageRunner({
      manifest: makeManifest({ name: "Foo Co", slug: "foo" }),
      ventureRoot: VENTURE,
      fs,
    });
    await runner.run();
    expect(orchestratorSpy).toHaveBeenCalledTimes(1);
    const call = orchestratorSpy.mock.calls[0]![0] as {
      ventureRoot: string;
      ventureName: string;
      ventureSlug: string;
    };
    expect(call.ventureRoot).toBe(VENTURE);
    expect(call.ventureName).toBe("Foo Co");
    expect(call.ventureSlug).toBe("foo");
  });
});

describe("HandoffPackStageRunner -- partial + total failure", () => {
  it("status='completed' when some PDFs rendered AND some failed", async () => {
    orchestratorSpy.mockReset().mockResolvedValue(fakeArtefacts({ generated: 1, failed: 1 }));
    const fs = new InMemoryFs();
    brandShipped(fs);
    const runner = new HandoffPackStageRunner({
      manifest: makeManifest(),
      ventureRoot: VENTURE,
      fs,
    });
    const result = await runner.run();
    expect(result.success).toBe(true);
    const parsed = HandoffPackCheckpointSchema.parse(
      JSON.parse(fs.files.get(getHandoffPackCheckpointPath(VENTURE))!),
    );
    expect(parsed.status).toBe("completed");
    expect(parsed.docsRendered).toBe(1);
    expect(parsed.docsFailed).toBe(1);
  });

  it("status='failed' when nothing rendered AND there were failures", async () => {
    orchestratorSpy.mockReset().mockResolvedValue(fakeArtefacts({ generated: 0, failed: 2 }));
    const fs = new InMemoryFs();
    brandShipped(fs);
    const runner = new HandoffPackStageRunner({
      manifest: makeManifest(),
      ventureRoot: VENTURE,
      fs,
    });
    const result = await runner.run();
    // Runner still emits success=true because checkpoint+inventory got
    // written; the *checkpoint status* is the canonical signal.
    expect(result.success).toBe(true);
    const parsed = HandoffPackCheckpointSchema.parse(
      JSON.parse(fs.files.get(getHandoffPackCheckpointPath(VENTURE))!),
    );
    expect(parsed.status).toBe("failed");
    expect(parsed.docsFailed).toBe(2);
    expect(parsed.docsRendered).toBe(0);
  });
});

describe("HandoffPackStageRunner -- review gates + error code branches", () => {
  it("creates a review gate when HANDOFF_PACK is in pipeline.reviewGates", async () => {
    orchestratorSpy.mockReset().mockResolvedValue(fakeArtefacts({ generated: 4 }));
    const fs = new InMemoryFs();
    brandShipped(fs);
    const runner = new HandoffPackStageRunner({
      manifest: makeManifest({
        pipeline: { reviewGates: ["HANDOFF_PACK"] },
      }),
      ventureRoot: VENTURE,
      fs,
    });
    const result = await runner.run();
    expect(result.success).toBe(true);
    expect(result.requiresReview).toBe(true);
    expect(result.nextStageReady).toBe(false);
    expect(result.reviewGateId).toBeDefined();
    expect(result.reviewGateId).toContain("HANDOFF_PACK");

    const gates = JSON.parse(fs.files.get(getReviewGatesPath(VENTURE))!) as Array<{
      stageName: string;
      requiredApproval: string;
      status: string;
    }>;
    expect(gates).toHaveLength(1);
    expect(gates[0]!.stageName).toBe("HANDOFF_PACK");
    expect(gates[0]!.requiredApproval).toBe("business");
    expect(gates[0]!.status).toBe("pending");
  });

  it("maps a brand-missing error from the orchestrator to HANDOFF_PACK_BRAND_MISSING", async () => {
    const brandMissing = new Error(
      "BRAND stage has not shipped yet -- expected file not found: /v/03_brand/brand-kit/brand-brief.json",
    );
    brandMissing.name = "HandoffPackBrandMissingError";
    orchestratorSpy.mockReset().mockRejectedValue(brandMissing);
    const fs = new InMemoryFs();
    brandShipped(fs); // validate passes; the error fires inside run()
    const runner = new HandoffPackStageRunner({
      manifest: makeManifest(),
      ventureRoot: VENTURE,
      fs,
    });
    const result = await runner.run();
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("HANDOFF_PACK_BRAND_MISSING");
    expect(result.error?.recoverable).toBe(true);
  });
});

describe("HandoffPackStageRunner -- contract sanity", () => {
  it("the imported DOC_MANIFEST_COUNT is non-zero (drift sentinel)", () => {
    // If slice 1's manifest ever shrinks to zero the run() log payload
    // would silently report `totalDocs: 0`; pin a lower bound here.
    expect(DOC_MANIFEST_COUNT).toBeGreaterThanOrEqual(200);
  });
});
