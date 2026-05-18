import { describe, expect, it } from "vitest";

import type { CrmEngine, CrmProvider } from "@founder-os/crm-core";

import { pickActiveCrmProvider } from "../src/resolver.js";

function stubProvider(
  engine: CrmEngine,
  available: boolean | (() => boolean | Promise<boolean>)
): CrmProvider {
  const probe = typeof available === "function" ? available : () => available;
  return {
    name: engine,
    async available() {
      return await probe();
    },
    async provision() {
      throw new Error("not used in resolver tests");
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

describe("pickActiveCrmProvider", () => {
  it("picks the first available provider", async () => {
    const res = await pickActiveCrmProvider({
      tierList: ["frappe_docker", "frappe_bench", "config_only"],
      providers: {
        frappe_docker: stubProvider("frappe_docker", false),
        frappe_bench: stubProvider("frappe_bench", true),
        config_only: stubProvider("config_only", true),
      },
    });
    expect(res.provider?.name).toBe("frappe_bench");
    expect(res.attempts).toEqual([
      { engine: "frappe_docker", available: false },
      { engine: "frappe_bench", available: true },
    ]);
  });

  it("falls through to config_only when nothing else is available", async () => {
    const res = await pickActiveCrmProvider({
      tierList: ["frappe_docker", "frappe_bench", "config_only"],
      providers: {
        frappe_docker: stubProvider("frappe_docker", false),
        frappe_bench: stubProvider("frappe_bench", false),
        config_only: stubProvider("config_only", true),
      },
    });
    expect(res.provider?.name).toBe("config_only");
  });

  it("treats missing providers as skipped, not failed", async () => {
    const res = await pickActiveCrmProvider({
      tierList: ["frappe_docker", "frappe_bench", "config_only"],
      providers: {
        config_only: stubProvider("config_only", true),
      },
    });
    expect(res.provider?.name).toBe("config_only");
    expect(res.attempts[0]).toEqual({
      engine: "frappe_docker",
      available: false,
      skipped: true,
    });
    expect(res.attempts[1]).toEqual({
      engine: "frappe_bench",
      available: false,
      skipped: true,
    });
  });

  it("treats a thrown available() as unavailable, not as a fatal error", async () => {
    const res = await pickActiveCrmProvider({
      tierList: ["frappe_docker", "config_only"],
      providers: {
        frappe_docker: stubProvider("frappe_docker", () => {
          throw new Error("daemon down");
        }),
        config_only: stubProvider("config_only", true),
      },
    });
    expect(res.provider?.name).toBe("config_only");
    expect(res.attempts[0]).toEqual({
      engine: "frappe_docker",
      available: false,
    });
  });

  it("returns null when no provider is available", async () => {
    const res = await pickActiveCrmProvider({
      tierList: ["frappe_docker"],
      providers: {
        frappe_docker: stubProvider("frappe_docker", false),
      },
    });
    expect(res.provider).toBeNull();
  });
});
