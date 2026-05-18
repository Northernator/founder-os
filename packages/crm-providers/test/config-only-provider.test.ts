import { describe, expect, it } from "vitest";

import { createConfigOnlyProvider } from "../src/config-only-provider.js";

describe("createConfigOnlyProvider", () => {
  it("always reports available=true", async () => {
    const p = createConfigOnlyProvider();
    expect(await p.available()).toBe(true);
  });

  it("provision() returns a CrmInstance with engine=config_only and no siteUrl", async () => {
    const p = createConfigOnlyProvider({ now: () => "2026-05-12T00:00:00.000Z" });
    const inst = await p.provision({
      ventureSlug: "acme",
      adminEmail: "chris@example.com",
    });
    expect(inst.engine).toBe("config_only");
    expect(inst.siteUrl).toBeUndefined();
    expect(inst.adminEmail).toBe("chris@example.com");
    expect(inst.ventureSlug).toBe("acme");
    expect(inst.provisionedAt).toBe("2026-05-12T00:00:00.000Z");
  });

  it("captures upserts in a snapshot the runner can read back", async () => {
    const p = createConfigOnlyProvider();
    await p.upsertSegments([
      { id: "icp-primary", label: "UK SMBs", source: "validation_icp", criteria: {} },
    ]);
    await p.upsertContacts([
      { source: "manual", segmentIds: [], email: "a@b.com" },
    ]);
    await p.upsertOpportunities([
      { title: "Acme demo", source: "manual", status: "lead" },
    ]);
    await p.upsertTemplates([
      { id: "email-welcome", subject: "Hi", body: "Welcome" },
    ]);
    await p.createCampaign({
      id: "launch",
      label: "Launch",
      templateIds: ["email-welcome"],
      segmentIds: ["icp-primary"],
      embeddedAssets: [],
      autoSend: false,
    });

    const snap = p.snapshot();
    expect(snap.segments).toHaveLength(1);
    expect(snap.contacts).toHaveLength(1);
    expect(snap.opportunities).toHaveLength(1);
    expect(snap.templates).toHaveLength(1);
    expect(snap.campaigns).toHaveLength(1);
    expect(snap.campaigns[0]?.id).toBe("launch");
  });

  it("createCampaign returns an undefined url (no Frappe site to point at)", async () => {
    const p = createConfigOnlyProvider();
    const res = await p.createCampaign({
      id: "launch",
      label: "Launch",
      templateIds: [],
      segmentIds: [],
      embeddedAssets: [],
      autoSend: false,
    });
    expect(res.id).toBe("launch");
    expect(res.url).toBeUndefined();
  });
});
