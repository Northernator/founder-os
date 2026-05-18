import { describe, expect, it } from "vitest";
import { createPostizProvider } from "../src/postiz-provider.js";
import type { FetchLike } from "../src/postiz-http.js";
import type { PostizConfig, SocialPost } from "@founder-os/social-core";

const config: PostizConfig = {
  baseUrl: "http://localhost:7777",
  apiKeyEnvVar: "POSTIZ_API_KEY",
  allowRemoteOnly: false,
};

const basePost: SocialPost = {
  ventureSlug: "demo",
  text: "hi",
  platforms: ["x"],
};

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("createPostizProvider.available", () => {
  it("returns available=true on /api/v1/health 200", async () => {
    const fetchImpl: FetchLike = async (input) => {
      expect(String(input)).toMatch(/\/api\/v1\/health$/);
      return new Response("ok", { status: 200 });
    };
    const adapter = createPostizProvider({
      config,
      env: { POSTIZ_API_KEY: "k" },
      fetchImpl,
    });
    expect(await adapter.available()).toEqual({ available: true });
  });

  it("returns reason when API key env var is missing", async () => {
    const adapter = createPostizProvider({
      config,
      env: {},
      fetchImpl: async () => new Response("never called"),
    });
    const probe = await adapter.available();
    expect(probe.available).toBe(false);
    expect(probe.reason).toMatch(/POSTIZ_API_KEY/);
  });

  it("allowRemoteOnly: rejects non-LAN baseUrl with PostizRemoteHostBlockedError reason", async () => {
    const adapter = createPostizProvider({
      config: { ...config, baseUrl: "https://hosted.example.com", allowRemoteOnly: true },
      env: { POSTIZ_API_KEY: "k" },
      fetchImpl: async () => {
        throw new Error("fetch should not be called when host is blocked");
      },
    });
    const probe = await adapter.available();
    expect(probe.available).toBe(false);
    expect(probe.reason).toMatch(/non-local/);
  });
});

describe("createPostizProvider.post", () => {
  it("happy path: uploads media (2-step) then creates posts; maps response onto rows", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.endsWith("/api/v1/upload")) {
        return jsonResponse({ id: "media-abc", url: "https://cdn/postiz/abc.mp4" });
      }
      if (url.endsWith("/api/v1/posts")) {
        return jsonResponse({
          posts: [
            { integration: "x", id: "p1", releaseURL: "https://x.com/u/1", status: "published" },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const adapter = createPostizProvider({
      config,
      env: { POSTIZ_API_KEY: "k" },
      fetchImpl,
      readMediaImpl: async (path) => ({
        data: new Uint8Array([1, 2, 3, 4]),
        filename: path.split("/").pop() ?? "file",
        contentType: "video/mp4",
      }),
    });
    const result = await adapter.post({
      ...basePost,
      media: [{ path: "/tmp/launch.mp4", kind: "video", digestSha256: "abc" }],
    });
    expect(result.backend).toBe("postiz");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      platform: "x",
      success: true,
      postUrl: "https://x.com/u/1",
      postId: "p1",
    });
    expect(calls.map((c) => c.method)).toEqual(["POST", "POST"]);
    expect(calls[0]?.url).toMatch(/upload$/);
    expect(calls[1]?.url).toMatch(/posts$/);
  });

  it("scheduled post: rawAdapterPayload marks scheduled=true and forwards scheduleAt to API", async () => {
    let bodySeen: string | undefined;
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/v1/posts")) {
        bodySeen = String(init?.body ?? "");
        return jsonResponse({
          posts: [{ integration: "x", id: "p9", status: "scheduled" }],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const adapter = createPostizProvider({
      config,
      env: { POSTIZ_API_KEY: "k" },
      fetchImpl,
    });
    const result = await adapter.post({
      ...basePost,
      scheduleAt: "2026-06-01T10:00:00.000Z",
    });
    expect(result.rows[0]?.success).toBe(true);
    expect(result.rawAdapterPayload).toMatchObject({ scheduled: true });
    expect(bodySeen).toMatch(/2026-06-01T10:00:00.000Z/);
  });

  it("media upload failure short-circuits to media-rejected rows for every platform", async () => {
    const fetchImpl: FetchLike = async (input) => {
      if (String(input).endsWith("/api/v1/upload")) {
        return new Response("file too large", { status: 413 });
      }
      throw new Error("posts endpoint should not be called");
    };
    const adapter = createPostizProvider({
      config,
      env: { POSTIZ_API_KEY: "k" },
      fetchImpl,
      readMediaImpl: async () => ({
        data: new Uint8Array([0]),
        filename: "huge.mp4",
        contentType: "video/mp4",
      }),
    });
    const result = await adapter.post({
      ...basePost,
      platforms: ["x", "linkedin"],
      media: [{ path: "/tmp/huge.mp4", kind: "video" }],
    });
    expect(result.rows).toHaveLength(2);
    for (const row of result.rows) {
      expect(row.success).toBe(false);
      expect(row.errorCode).toBe("media-rejected");
    }
  });
});
