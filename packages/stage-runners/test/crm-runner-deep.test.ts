import { describe, expect, it, vi } from "vitest";
import type { CrmProvider } from "@founder-os/crm-core";
import { InMemoryFs } from "./_helpers/in-memory-fs.js";
import { makeManifest } from "./_helpers/manifest.js";

const provisionSpy = vi.fn();
const seedSpy = vi.fn();
const campaignSpy = vi.fn();

const orchestrateTopic = vi.fn(async () => ({
  briefing: {
    ventureSlug: "test",
    topicSlug: "crm-frappe-and-outreach-current-state",
    topicLabel: "Frappe CRM v1.7x release notes and outreach pattern current state",
    questions: [
      {
        id: "q-crm-frappe-current-state",
        question: "Frappe CRM v1.7x current state?",
        angle: "technical",
        priority: "must",
      },
    ],
    sections: [
      {
        heading: "Frappe CRM current state",
        body: "Frappe CRM v1.7x adds CRM Lead Source customisation; Docker tag tracks v1.7-stable.",
        sources: ["https://example.com/frappe-crm"],
      },
    ],
    sources: [
      {
        url: "https://example.com/frappe-crm",
        title: "Frappe CRM v1.7",
        publisher: "Frappe",
        accessedAt: "2026-05-18T00:00:00.000Z",
        retrievedBy: "claude-sub",
        trustTier: "primary",
      },
    ],
    channelsUsed: ["claude-sub"],
    crossReferencedBy: [],
    synthesisedBy: "claude-sub",
    disagreements: [],
    unanswered: [],
    generatedAt: "2026-05-18T00:00:00.000Z",
    staleAfterDays: 7,
  },
  plan: { questions: [], fallbackIndex: 0 },
  transcripts: {
    planner: null,
    crossReference: null,
    synthesiser: null,
    workers: { outcomes: [], successes: new Map(), failures: new Map() },
  },
}));

vi.mock("@founder-os/pipeline-runner", () => ({
  createCrmProvisionStep: (ctx: unknown) => provisionSpy(ctx),
  createCrmSeedStep: (ctx: unknown) => seedSpy(ctx),
  createCrmCampaignTemplateStep: (ctx: unknown) => campaignSpy(ctx),
}));

vi.mock("@founder-os/research-deep-orchestrator", () => ({ orchestrateTopic }));

const { CrmStageRunner } = await import("../src/runners/crm-runner.js");

function stubProvider(): CrmProvider {
  return {
    name: "config_only",
    async available() {
      return true;
    },
    async provision({ ventureSlug, adminEmail }) {
      return {
        ventureSlug,
        engine: "config_only",
        adminEmail,
        provisionedAt: "2026-05-18T00:00:00.000Z",
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

function okProvision() {
  const provider = stubProvider();
  return {
    instance: {
      ventureSlug: "test",
      engine: "config_only" as const,
      adminEmail: "f@example.com",
      provisionedAt: "2026-05-18T00:00:00.000Z",
      siteUrl: "config-only://test",
    },
    engine: "config_only" as const,
    instancePath: "/v/11_crm/crm-instance.json",
    attempts: ["config_only"],
    provider,
  };
}

const okSeed = {
  segmentsUpserted: 2,
  contactsUpserted: 5,
  opportunitiesUpserted: 1,
  contactsBySource: { icp: 5 },
  artifactPaths: ["/v/11_crm/seed.json"],
};

const okCampaign = {
  templates: [
    { id: "email-welcome", subject: "s", body: "b" },
    { id: "email-followup-1", subject: "s", body: "b" },
    { id: "email-followup-2", subject: "s", body: "b" },
    { id: "email-demo-invite", subject: "s", body: "b" },
  ],
  campaign: { id: "launch-campaign", label: "x", templateIds: [], segmentIds: [], autoSend: false },
  campaignResult: { id: "launch-campaign", url: "https://example.com/c" },
  artifactPaths: ["/v/11_crm/launch-campaign.json"],
  generationSource: "llm" as const,
};

describe("CrmStageRunner deep research adoption", () => {
  it("gathers a Frappe+outreach briefing and threads it into the campaign step", async () => {
    orchestrateTopic.mockClear();
    provisionSpy.mockReset().mockResolvedValue(okProvision());
    seedSpy.mockReset().mockResolvedValue(okSeed);
    campaignSpy.mockReset().mockResolvedValue(okCampaign);

    const fs = new InMemoryFs();
    await fs.writeFile("/v/03_brand/brand-voice.md", "Tone: warm, concise.");
    const runner = new CrmStageRunner({
      manifest: makeManifest({ industry: "B2B SaaS" }),
      ventureRoot: "/v",
      fs,
      callLlm: async () => "stub",
      enableDeepResearch: true,
      runId: "run-crm",
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(result.artifactsCreated).toEqual(
      expect.arrayContaining([
        "/v/00_research/deep/briefings/crm-frappe-and-outreach-current-state.md",
        "/v/00_research/deep/briefings/crm-frappe-and-outreach-current-state.json",
      ])
    );
    expect(result.logs.map((l) => l.message)).toContain("crm: deep-research ready");

    expect(orchestrateTopic).toHaveBeenCalledTimes(1);
    const opts = orchestrateTopic.mock.calls[0]?.[0] as {
      topic: { slug: string };
      ventureContext: string;
      staleAfterDays: number;
    };
    expect(opts.topic.slug).toBe("crm-frappe-and-outreach-current-state");
    expect(opts.staleAfterDays).toBe(7);
    expect(opts.ventureContext).toContain("Brand voice notes");

    expect(campaignSpy).toHaveBeenCalledTimes(1);
    const campaignCtx = campaignSpy.mock.calls[0]?.[0] as {
      deepResearch?: { filename: string; excerpt: string }[];
    };
    expect(campaignCtx.deepResearch).toBeDefined();
    expect(campaignCtx.deepResearch?.[0]?.filename).toBe(
      "crm-frappe-and-outreach-current-state.md",
    );
    expect(campaignCtx.deepResearch?.[0]?.excerpt).toContain("Frappe CRM current state");

    const artifactIndex = Array.from(fs.files.values()).find((value) =>
      value.includes("crm-deep-research"),
    );
    expect(artifactIndex).toBeDefined();
  });

  it("keeps the deterministic CRM path when not enabled", async () => {
    orchestrateTopic.mockClear();
    provisionSpy.mockReset().mockResolvedValue(okProvision());
    seedSpy.mockReset().mockResolvedValue(okSeed);
    campaignSpy.mockReset().mockResolvedValue(okCampaign);

    const fs = new InMemoryFs();
    const runner = new CrmStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      callLlm: async () => "stub",
      runId: "run-crm",
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(orchestrateTopic).not.toHaveBeenCalled();
    const campaignCtx = campaignSpy.mock.calls[0]?.[0] as {
      deepResearch?: unknown;
    };
    expect(campaignCtx.deepResearch).toBeUndefined();
  });

  it("skips deep research when no callLlm provided", async () => {
    orchestrateTopic.mockClear();
    provisionSpy.mockReset().mockResolvedValue(okProvision());
    seedSpy.mockReset().mockResolvedValue(okSeed);
    campaignSpy.mockReset().mockResolvedValue(okCampaign);

    const fs = new InMemoryFs();
    const runner = new CrmStageRunner({
      manifest: makeManifest(),
      ventureRoot: "/v",
      fs,
      enableDeepResearch: true,
      runId: "run-crm",
    });

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(orchestrateTopic).not.toHaveBeenCalled();
  });
});
