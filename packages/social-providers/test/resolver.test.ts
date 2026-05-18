import { describe, expect, it } from "vitest";
import { pickActiveSocialAdapter } from "../src/resolver.js";
import type { SocialAdapter, SocialBackend } from "@founder-os/social-core";

function stubAdapter(
  name: SocialBackend,
  available: boolean,
  reason?: string
): SocialAdapter {
  return {
    name,
    async available() {
      return { available, reason };
    },
    async loginState() {
      return {};
    },
    async post() {
      throw new Error("stub adapter cannot post");
    },
  };
}

describe("pickActiveSocialAdapter", () => {
  it("returns the first available adapter in tier order and stops probing", async () => {
    const probed: SocialBackend[] = [];
    const trace = (backend: SocialBackend, available: boolean) =>
      stubAdapter(backend, available, undefined);

    // Wrap to record probe order.
    const wrap = (backend: SocialBackend, available: boolean): SocialAdapter => ({
      ...trace(backend, available),
      async available() {
        probed.push(backend);
        return { available };
      },
    });

    const res = await pickActiveSocialAdapter({
      tierList: ["social-poster", "postiz", "config_only"],
      adapters: {
        "social-poster": wrap("social-poster", false),
        postiz: wrap("postiz", true),
        config_only: wrap("config_only", true),
      },
    });
    expect(res.adapter?.name).toBe("postiz");
    expect(probed).toEqual(["social-poster", "postiz"]);
    expect(res.attempts).toEqual([
      { backend: "social-poster", available: false },
      { backend: "postiz", available: true },
    ]);
  });

  it("captures the SocialAvailability reason in the attempts trace", async () => {
    const res = await pickActiveSocialAdapter({
      tierList: ["social-poster", "config_only"],
      adapters: {
        "social-poster": stubAdapter(
          "social-poster",
          false,
          "sp CLI not found on PATH"
        ),
        config_only: stubAdapter("config_only", true),
      },
    });
    expect(res.adapter?.name).toBe("config_only");
    expect(res.attempts[0]).toMatchObject({
      backend: "social-poster",
      available: false,
      reason: "sp CLI not found on PATH",
    });
  });

  it("marks missing adapters as skipped without failing", async () => {
    const res = await pickActiveSocialAdapter({
      tierList: ["postiz", "social-poster"],
      adapters: {
        "social-poster": stubAdapter("social-poster", true),
      },
    });
    expect(res.adapter?.name).toBe("social-poster");
    expect(res.attempts[0]).toEqual({
      backend: "postiz",
      available: false,
      skipped: true,
    });
  });

  it("treats a throwing available() as unavailable + records the message", async () => {
    const throwing: SocialAdapter = {
      name: "postiz",
      async available() {
        throw new Error("boom");
      },
      async loginState() {
        return {};
      },
      async post() {
        throw new Error("never");
      },
    };
    const res = await pickActiveSocialAdapter({
      tierList: ["postiz", "config_only"],
      adapters: { postiz: throwing, config_only: stubAdapter("config_only", true) },
    });
    expect(res.adapter?.name).toBe("config_only");
    expect(res.attempts[0]).toMatchObject({
      backend: "postiz",
      available: false,
      reason: "boom",
    });
  });
});
