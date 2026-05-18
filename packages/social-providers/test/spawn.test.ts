import { describe, expect, it } from "vitest";
import {
  detectErrorCode,
  mapSpStatusToLoginState,
  parseSpPostStdout,
} from "../src/social-poster-parse.js";
import type { SocialPosterSpawnResult } from "../src/spawn.js";

const ok = (stdout: string): SocialPosterSpawnResult => ({
  stdout,
  stderr: "",
  code: 0,
});

describe("mapSpStatusToLoginState", () => {
  it("normalises platform aliases (twitter -> x, ig -> instagram)", () => {
    const state = mapSpStatusToLoginState(
      JSON.stringify({ twitter: "logged in", ig: "logged out", linkedin: "ok" })
    );
    expect(state.x).toBe("logged_in");
    expect(state.instagram).toBe("logged_out");
    expect(state.linkedin).toBe("logged_in");
  });

  it("returns {} on malformed JSON without throwing", () => {
    expect(mapSpStatusToLoginState("not json")).toEqual({});
  });
});

describe("parseSpPostStdout", () => {
  it("array form: matches platforms by name, fills missing with no row", () => {
    const result = parseSpPostStdout(
      ok(
        JSON.stringify([
          { platform: "x", success: true, url: "https://x.com/1" },
        ])
      ),
      ["x", "linkedin"]
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ platform: "x", success: true });
    expect(result[1]).toMatchObject({
      platform: "linkedin",
      success: false,
      error: expect.stringMatching(/no row in sp stdout/),
    });
  });

  it("NDJSON form: one row per line", () => {
    const ndjson =
      JSON.stringify({ platform: "x", success: true, url: "u1" }) +
      "\n" +
      JSON.stringify({ platform: "linkedin", success: true, url: "u2" });
    const result = parseSpPostStdout(ok(ndjson), ["x", "linkedin"]);
    expect(result.every((r) => r.success)).toBe(true);
  });
});

describe("detectErrorCode", () => {
  it("maps known stderr patterns to structured codes", () => {
    expect(detectErrorCode("rate limit exceeded")).toBe("rate-limited");
    expect(detectErrorCode("session expired, please log in")).toBe(
      "not-logged-in"
    );
    expect(detectErrorCode("media too large")).toBe("media-rejected");
    expect(detectErrorCode("503 Service Unavailable")).toBe("platform-down");
    expect(detectErrorCode("something weird")).toBe("unknown");
    expect(detectErrorCode(undefined)).toBe("unknown");
  });
});
