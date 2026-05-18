/**
 * Slice 4 of the Supabase arc -- vitest suite for the real provider.
 *
 * Covers the contract surface laid out in SUPABASE-MODULE-SPEC.md sec 10:
 *
 *   - available() true/false branches.
 *   - provision() happy path returns a BackendInstance with the expected shape.
 *   - provision() surfaces SupabaseHealthError on health-probe failure.
 *   - applySchema() surfaces MissingExecSqlError when exec_sql isn'\''t installed.
 *   - applySchema() runs the full plan (table + indexes + trigger + RLS) via execSql.
 *   - applySchema() emits expected DDL for a 3-field collection (string-match).
 *   - applySchema() emits RLS policies for the 5 verbs.
 *   - export() emits a BackendExport with source: "supabase".
 *   - export() falls back to ["password"] when /auth/v1/settings is unreachable.
 *
 * fetchImpl is mocked via a small handler routing on URL+method. No real
 * network IO. fetchImpl is bound to `globalThis` per the
 * feedback_browser_fetch_illegal_invocation memory -- the provider uses
 * the injected impl directly so no bind shenanigans are needed in tests.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createSupabaseProvider,
  MissingExecSqlError,
  SupabaseBadCredentialsError,
  SupabaseHealthError,
} from "../src/index.js";

import type { Collection, SupabaseConfig } from "@founder-os/backend-core";

const VALID_CONFIG: SupabaseConfig = {
  projectUrl: "https://abc123.supabase.co",
  anonKeyEnvVar: "SUPABASE_ANON_KEY",
  serviceRoleKeyEnvVar: "SUPABASE_SERVICE_ROLE_KEY",
};

const VALID_ENV: Record<string, string> = {
  SUPABASE_ANON_KEY: "anon-jwt",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-jwt",
};

const FIXED_NOW = "2026-05-13T00:00:00.000Z";

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function makeFetch(handler: FetchHandler): typeof fetch {
  return ((input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    return handler(url, init);
  }) as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

// ---------------------------------------------------------------------------

describe("createSupabaseProvider -- available()", () => {
  it("returns true when both env vars resolve cleanly", async () => {
    const provider = createSupabaseProvider({
      config: VALID_CONFIG,
      env: VALID_ENV,
    });
    await expect(provider.available()).resolves.toBe(true);
  });

  it("returns false when the anon key env var is missing", async () => {
    const provider = createSupabaseProvider({
      config: VALID_CONFIG,
      env: { SUPABASE_SERVICE_ROLE_KEY: "service-role-jwt" },
    });
    await expect(provider.available()).resolves.toBe(false);
  });

  it("returns false when the service-role key env var is missing", async () => {
    const provider = createSupabaseProvider({
      config: VALID_CONFIG,
      env: { SUPABASE_ANON_KEY: "anon-jwt" },
    });
    await expect(provider.available()).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("createSupabaseProvider -- provision()", () => {
  it("validates the project URL via /auth/v1/health and returns a BackendInstance", async () => {
    const fetchImpl = makeFetch(async (url) => {
      if (url.endsWith("/auth/v1/health")) {
        return textResponse(200, "GoTrue v2.143.0");
      }
      throw new Error("unexpected URL: " + url);
    });
    const provider = createSupabaseProvider({
      config: VALID_CONFIG,
      env: VALID_ENV,
      fetchImpl,
      now: () => FIXED_NOW,
    });
    const instance = await provider.provision({
      ventureSlug: "demo",
      ventureRoot: "/tmp/demo",
      adminEmail: "founder@example.com",
    });
    expect(instance.engine).toBe("supabase");
    expect(instance.ventureSlug).toBe("demo");
    expect(instance.baseUrl).toBe("https://abc123.supabase.co");
    expect(instance.resolvedVersion).toBe("GoTrue v2.143.0");
    expect(instance.adminEmail).toBe("founder@example.com");
    expect(instance.provisionedAt).toBe(FIXED_NOW);
    expect(instance.notes).toMatch(/BYOP/i);
  });

  it("surfaces SupabaseHealthError when the project URL is unreachable", async () => {
    const fetchImpl = makeFetch(async () => textResponse(500, "boom"));
    const provider = createSupabaseProvider({
      config: VALID_CONFIG,
      env: VALID_ENV,
      fetchImpl,
    });
    await expect(
      provider.provision({
        ventureSlug: "demo",
        ventureRoot: "/tmp/demo",
        adminEmail: "founder@example.com",
      })
    ).rejects.toBeInstanceOf(SupabaseHealthError);
  });

  it("surfaces SupabaseBadCredentialsError when env vars resolve but are empty", async () => {
    const provider = createSupabaseProvider({
      config: VALID_CONFIG,
      env: { SUPABASE_ANON_KEY: "", SUPABASE_SERVICE_ROLE_KEY: "" },
    });
    await expect(
      provider.provision({
        ventureSlug: "demo",
        ventureRoot: "/tmp/demo",
        adminEmail: "founder@example.com",
      })
    ).rejects.toBeInstanceOf(SupabaseBadCredentialsError);
  });
});

// ---------------------------------------------------------------------------

const TASK_COLLECTION: Collection = {
  name: "task",
  type: "base",
  fields: [
    { name: "title", kind: "text", required: true, unique: false },
    { name: "done", kind: "bool", required: false, unique: false },
    {
      name: "owner_id",
      kind: "relation",
      required: true,
      unique: false,
      relatesTo: "user",
      cascadeDelete: true,
    },
  ],
  apiRules: {
    list: "@request.auth.id != ''",
    view: "@request.auth.id != ''",
    create: "@request.auth.id != ''",
    update: "owner_id = @request.auth.id",
    delete: "owner_id = @request.auth.id",
  },
  indexes: ["title"],
  softDelete: false,
};

describe("createSupabaseProvider -- applySchema()", () => {
  it("throws MissingExecSqlError when the helper isn'\''t installed", async () => {
    const fetchImpl = makeFetch(async (url) => {
      if (url.endsWith("/rest/v1/rpc/exec_sql")) {
        return textResponse(404, "");
      }
      throw new Error("unexpected URL: " + url);
    });
    const provider = createSupabaseProvider({
      config: VALID_CONFIG,
      env: VALID_ENV,
      fetchImpl,
    });
    await expect(
      provider.applySchema({
        ventureRoot: "/tmp/demo",
        baseUrl: VALID_CONFIG.projectUrl,
        collections: [TASK_COLLECTION],
      })
    ).rejects.toBeInstanceOf(MissingExecSqlError);
  });

  it("runs the full plan and emits the expected SQL shape", async () => {
    let firstCall = true;
    const executed: string[] = [];
    const fetchImpl = makeFetch(async (url, init) => {
      if (url.endsWith("/rest/v1/rpc/exec_sql")) {
        const body = init?.body ? JSON.parse(init.body as string) : null;
        if (firstCall) {
          firstCall = false;
          return jsonResponse(200, null);
        }
        if (body && typeof body.query === "string") {
          executed.push(body.query);
        }
        return jsonResponse(200, null);
      }
      throw new Error("unexpected URL: " + url);
    });
    const provider = createSupabaseProvider({
      config: VALID_CONFIG,
      env: VALID_ENV,
      fetchImpl,
    });

    await provider.applySchema({
      ventureRoot: "/tmp/demo",
      baseUrl: VALID_CONFIG.projectUrl,
      collections: [TASK_COLLECTION],
    });

    const allSql = executed.join("\n---\n");

    // 1. Shared updated-at trigger function lands first.
    expect(allSql).toMatch(/create or replace function public\.fos_touch_updated_at/);
    // 2. Table DDL with universal columns.
    expect(allSql).toMatch(/create table if not exists public\.task/);
    expect(allSql).toMatch(/id uuid primary key default gen_random_uuid/);
    expect(allSql).toMatch(/created_at timestamptz/);
    expect(allSql).toMatch(/updated_at timestamptz/);
    // 3. Field columns + relation FK.
    expect(allSql).toMatch(/title text not null/);
    expect(allSql).toMatch(/done boolean/);
    expect(allSql).toMatch(/owner_id uuid references user\(id\) on delete cascade not null/);
    // 4. Index.
    expect(allSql).toMatch(/create index if not exists task_title_idx on public\.task\(title\)/);
    // 5. Trigger.
    expect(allSql).toMatch(/create trigger task_touch_updated_at/);
    // 6. RLS enable + policies for the 4 verbs (select/insert/update/delete).
    expect(allSql).toMatch(/alter table public\.task enable row level security/);
    expect(allSql).toMatch(/create policy task_select on public\.task for select using/);
    expect(allSql).toMatch(/create policy task_insert on public\.task for insert with check/);
    expect(allSql).toMatch(/create policy task_update on public\.task for update using .* with check/);
    expect(allSql).toMatch(/create policy task_delete on public\.task for delete using/);
    // 7. DSL translation: @request.auth.id -> auth.uid()
    expect(allSql).toMatch(/auth\.uid\(\)/);
    // 8. No raw @request.auth.id should survive in the emitted SQL.
    expect(allSql).not.toMatch(/@request\.auth\.id/);
  });
});

// ---------------------------------------------------------------------------

describe("createSupabaseProvider -- export()", () => {
  it("emits a BackendExport with source='supabase' and password-only auth when settings unreachable", async () => {
    const fetchImpl = makeFetch(async (url) => {
      if (url.endsWith("/auth/v1/health")) {
        return textResponse(200, "GoTrue v2.143.0");
      }
      if (url.endsWith("/auth/v1/settings")) {
        return textResponse(500, "internal error");
      }
      throw new Error("unexpected URL: " + url);
    });
    const provider = createSupabaseProvider({
      config: VALID_CONFIG,
      env: VALID_ENV,
      fetchImpl,
      now: () => FIXED_NOW,
    });
    const instance = {
      ventureSlug: "demo",
      engine: "supabase" as const,
      baseUrl: VALID_CONFIG.projectUrl,
      resolvedVersion: "GoTrue v2.143.0",
      adminEmail: "founder@example.com",
      provisionedAt: FIXED_NOW,
    };
    const result = await provider.export(instance, [TASK_COLLECTION]);
    expect(result.engine).toBe("supabase");
    expect(result.source).toBe("supabase");
    expect(result.baseUrl).toBe(VALID_CONFIG.projectUrl);
    expect(result.collections).toEqual([TASK_COLLECTION]);
    expect(result.auth.providers).toEqual(["password"]);
    expect(result.sdk.importPath).toBe("@/lib/backend");
    expect(result.sdk.realtime).toBe(true);
    expect(result.generatedAt).toBe(FIXED_NOW);
    expect(result.notes.some((n) => n.includes("Supabase project URL"))).toBe(true);
  });

  it("picks up enabled OAuth providers from /auth/v1/settings", async () => {
    const fetchImpl = makeFetch(async (url) => {
      if (url.endsWith("/auth/v1/health")) {
        return textResponse(200, "GoTrue v2.143.0");
      }
      if (url.endsWith("/auth/v1/settings")) {
        return jsonResponse(200, {
          external: {
            google: { enabled: true },
            github: { enabled: true },
            apple: { enabled: false },
          },
        });
      }
      throw new Error("unexpected URL: " + url);
    });
    const provider = createSupabaseProvider({
      config: VALID_CONFIG,
      env: VALID_ENV,
      fetchImpl,
    });
    const instance = {
      ventureSlug: "demo",
      engine: "supabase" as const,
      baseUrl: VALID_CONFIG.projectUrl,
      adminEmail: "founder@example.com",
      provisionedAt: FIXED_NOW,
    };
    const result = await provider.export(instance, [TASK_COLLECTION]);
    expect(result.auth.providers).toEqual(
      expect.arrayContaining(["password", "google", "github"])
    );
    expect(result.auth.providers).not.toContain("apple");
  });
});
