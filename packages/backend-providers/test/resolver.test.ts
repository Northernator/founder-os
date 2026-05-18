import { describe, expect, it } from "vitest";
import type { BackendEngine, BackendProvider } from "@founder-os/backend-core";
import { pickActiveBackendProvider } from "../src/resolver.js";

function stubProvider(name: BackendEngine, available: boolean): BackendProvider {
  return {
    name,
    available: async () => available,
    provision: async () => {
      throw new Error("stub");
    },
    applySchema: async () => {
      throw new Error("stub");
    },
    export: async () => {
      throw new Error("stub");
    },
  };
}

describe("pickActiveBackendProvider", () => {
  it("returns the first available provider in tier order", async () => {
    const res = await pickActiveBackendProvider({
      tierList: ["pocketbase", "drizzle_sqlite", "config_only"],
      providers: {
        pocketbase: stubProvider("pocketbase", false),
        drizzle_sqlite: stubProvider("drizzle_sqlite", true),
        config_only: stubProvider("config_only", true),
      },
    });
    expect(res.provider?.name).toBe("drizzle_sqlite");
    expect(res.attempts).toHaveLength(2);
    expect(res.attempts[0]).toEqual({ engine: "pocketbase", available: false });
    expect(res.attempts[1]).toEqual({ engine: "drizzle_sqlite", available: true });
  });

  it("marks missing providers as skipped without failing", async () => {
    const res = await pickActiveBackendProvider({
      tierList: ["supabase", "pocketbase", "config_only"],
      providers: {
        pocketbase: stubProvider("pocketbase", true),
        config_only: stubProvider("config_only", true),
      },
    });
    expect(res.provider?.name).toBe("pocketbase");
    expect(res.attempts[0]).toEqual({ engine: "supabase", available: false, skipped: true });
  });

  it("returns null when every provider is unavailable", async () => {
    const res = await pickActiveBackendProvider({
      tierList: ["pocketbase", "drizzle_sqlite"],
      providers: {
        pocketbase: stubProvider("pocketbase", false),
        drizzle_sqlite: stubProvider("drizzle_sqlite", false),
      },
    });
    expect(res.provider).toBeNull();
    expect(res.attempts).toHaveLength(2);
  });

  it("treats a throwing available() as unavailable", async () => {
    const throwing: BackendProvider = {
      name: "pocketbase",
      available: async () => {
        throw new Error("boom");
      },
      provision: async () => {
        throw new Error("stub");
      },
      applySchema: async () => {
        throw new Error("stub");
      },
      export: async () => {
        throw new Error("stub");
      },
    };
    const res = await pickActiveBackendProvider({
      tierList: ["pocketbase", "config_only"],
      providers: { pocketbase: throwing, config_only: stubProvider("config_only", true) },
    });
    expect(res.provider?.name).toBe("config_only");
    expect(res.attempts[0]).toEqual({ engine: "pocketbase", available: false });
  });
});

describe("pickActiveBackendProvider with the real Supabase provider", () => {
  it("picks supabase when its credentials resolve and pocketbase is unavailable", async () => {
    const { createSupabaseProvider } = await import("../src/supabase-provider.js");
    const supabase = createSupabaseProvider({
      config: {
        projectUrl: "https://abc.supabase.co",
        anonKeyEnvVar: "SUPABASE_ANON_KEY",
        serviceRoleKeyEnvVar: "SUPABASE_SERVICE_ROLE_KEY",
      },
      env: {
        SUPABASE_ANON_KEY: "anon",
        SUPABASE_SERVICE_ROLE_KEY: "service",
      },
    });
    const res = await pickActiveBackendProvider({
      tierList: ["pocketbase", "supabase", "config_only"],
      providers: {
        pocketbase: stubProvider("pocketbase", false),
        supabase,
        config_only: stubProvider("config_only", true),
      },
    });
    expect(res.provider?.name).toBe("supabase");
    // PocketBase tried first (false), supabase next (true). config_only
    // never probed because supabase wins.
    expect(res.attempts).toEqual([
      { engine: "pocketbase", available: false },
      { engine: "supabase", available: true },
    ]);
  });

  it("skips supabase when credentials are missing, falls through to next tier", async () => {
    const { createSupabaseProvider } = await import("../src/supabase-provider.js");
    const supabase = createSupabaseProvider({
      config: {
        projectUrl: "https://abc.supabase.co",
        anonKeyEnvVar: "SUPABASE_ANON_KEY",
        serviceRoleKeyEnvVar: "SUPABASE_SERVICE_ROLE_KEY",
      },
      env: {}, // no env vars set -- available() should return false
    });
    const res = await pickActiveBackendProvider({
      tierList: ["supabase", "config_only"],
      providers: {
        supabase,
        config_only: stubProvider("config_only", true),
      },
    });
    expect(res.provider?.name).toBe("config_only");
    expect(res.attempts[0]).toEqual({ engine: "supabase", available: false });
  });
});
