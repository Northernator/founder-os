/**
 * Slice 2 of the Supabase arc -- tests for resolveSupabaseCredentials.
 *
 * The helper lives in @founder-os/backend-core because it's pure and has
 * no Node deps, but @founder-os/backend-core itself has no vitest setup
 * (it's contract-only). The tests live here in backend-providers/test/
 * where vitest is already wired up via the package's own vitest.config.ts.
 *
 * Mirrors the discriminated-union test style used elsewhere in the
 * codebase for "resolve X from env" helpers.
 */
import { describe, expect, it } from "vitest";

import {
  resolveSupabaseCredentials,
  safeParseSupabaseConfig,
  SUPABASE_DEFAULT_ANON_KEY_ENV_VAR,
  SUPABASE_DEFAULT_SERVICE_ROLE_KEY_ENV_VAR,
  type SupabaseConfig,
} from "@founder-os/backend-core";

const VALID_CONFIG: SupabaseConfig = {
  projectUrl: "https://abc123.supabase.co",
  anonKeyEnvVar: SUPABASE_DEFAULT_ANON_KEY_ENV_VAR,
  serviceRoleKeyEnvVar: SUPABASE_DEFAULT_SERVICE_ROLE_KEY_ENV_VAR,
};

describe("resolveSupabaseCredentials", () => {
  it("resolves cleanly when both env vars are present", () => {
    const r = resolveSupabaseCredentials(VALID_CONFIG, {
      SUPABASE_ANON_KEY: "anon-jwt",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-jwt",
    });
    expect("error" in r).toBe(false);
    if ("error" in r) return; // narrow for TS
    expect(r.projectUrl).toBe("https://abc123.supabase.co");
    expect(r.anonKey).toBe("anon-jwt");
    expect(r.serviceRoleKey).toBe("service-role-jwt");
  });

  it("returns missing-env-var/anonKey when anon key absent", () => {
    const r = resolveSupabaseCredentials(VALID_CONFIG, {
      SUPABASE_SERVICE_ROLE_KEY: "service-role-jwt",
    });
    expect("error" in r).toBe(true);
    if (!("error" in r)) return;
    expect(r.which).toBe("anonKey");
    expect(r.envVarName).toBe("SUPABASE_ANON_KEY");
  });

  it("returns missing-env-var/serviceRoleKey when service-role key absent", () => {
    const r = resolveSupabaseCredentials(VALID_CONFIG, {
      SUPABASE_ANON_KEY: "anon-jwt",
    });
    expect("error" in r).toBe(true);
    if (!("error" in r)) return;
    expect(r.which).toBe("serviceRoleKey");
    expect(r.envVarName).toBe("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("treats empty-string env value as missing (whitespace-only too)", () => {
    const r1 = resolveSupabaseCredentials(VALID_CONFIG, {
      SUPABASE_ANON_KEY: "",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-jwt",
    });
    expect("error" in r1).toBe(true);
    if ("error" in r1) expect(r1.which).toBe("anonKey");

    const r2 = resolveSupabaseCredentials(VALID_CONFIG, {
      SUPABASE_ANON_KEY: "   ",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-jwt",
    });
    expect("error" in r2).toBe(true);
    if ("error" in r2) expect(r2.which).toBe("anonKey");
  });

  it("returns missing-env-var/projectUrl when projectUrl is empty", () => {
    // Bypass the zod URL check (which is enforced by safeParseSupabaseConfig)
    // by casting -- the runtime resolver still defensively checks projectUrl
    // because schema validation can be skipped in some call paths.
    const r = resolveSupabaseCredentials(
      { ...VALID_CONFIG, projectUrl: "" } as SupabaseConfig,
      {
        SUPABASE_ANON_KEY: "anon-jwt",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-jwt",
      }
    );
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.which).toBe("projectUrl");
  });

  it("uses custom per-venture env var names when configured", () => {
    const custom: SupabaseConfig = {
      projectUrl: "https://abc123.supabase.co",
      anonKeyEnvVar: "SUPABASE_ANON_KEY_MY_VENTURE",
      serviceRoleKeyEnvVar: "SUPABASE_SERVICE_ROLE_KEY_MY_VENTURE",
    };
    const r = resolveSupabaseCredentials(custom, {
      SUPABASE_ANON_KEY_MY_VENTURE: "anon-per-venture",
      SUPABASE_SERVICE_ROLE_KEY_MY_VENTURE: "service-per-venture",
      // Wrong-name globals -- must NOT be picked up.
      SUPABASE_ANON_KEY: "wrong",
      SUPABASE_SERVICE_ROLE_KEY: "wrong",
    });
    if ("error" in r) throw new Error("expected success");
    expect(r.anonKey).toBe("anon-per-venture");
    expect(r.serviceRoleKey).toBe("service-per-venture");
  });
});

describe("safeParseSupabaseConfig", () => {
  it("accepts a minimal config with just projectUrl (defaults fill in env-var names)", () => {
    const r = safeParseSupabaseConfig({
      projectUrl: "https://abc123.supabase.co",
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.anonKeyEnvVar).toBe(SUPABASE_DEFAULT_ANON_KEY_ENV_VAR);
    expect(r.data.serviceRoleKeyEnvVar).toBe(
      SUPABASE_DEFAULT_SERVICE_ROLE_KEY_ENV_VAR
    );
  });

  it("rejects a non-URL projectUrl", () => {
    const r = safeParseSupabaseConfig({
      projectUrl: "not a url",
    });
    expect(r.success).toBe(false);
  });

  it("rejects entirely-missing projectUrl", () => {
    const r = safeParseSupabaseConfig({});
    expect(r.success).toBe(false);
  });
});
