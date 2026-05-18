import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildSpPostArgs,
  captionNeedsTextFile,
  createSocialPosterProvider,
  groupPlatformsByOverride,
  trimToLongestCap,
} from "../src/social-poster-provider.js";
import {
  SocialPosterNotFoundError,
  type SocialPosterSpawnResult,
  type SpawnLike,
} from "../src/spawn.js";
import type { SocialPost } from "@founder-os/social-core";

function ok(stdout: string): SocialPosterSpawnResult {
  return { stdout, stderr: "", code: 0 };
}
function fail(stderr: string, code = 1): SocialPosterSpawnResult {
  return { stdout: "", stderr, code };
}

const basePost: SocialPost = {
  ventureSlug: "demo",
  text: "Launching today.",
  platforms: ["x", "linkedin"],
};

describe("createSocialPosterProvider.available", () => {
  it("returns available when sp --version exits 0", async () => {
    const spawnImpl: SpawnLike = async (args) => {
      expect(args).toEqual(["--version"]);
      return ok("0.4.2\n");
    };
    const adapter = createSocialPosterProvider({ spawnImpl });
    expect(await adapter.available()).toEqual({ available: true });
  });

  it("returns available=false with install hint when sp is not on PATH", async () => {
    const spawnImpl: SpawnLike = async () => {
      throw new SocialPosterNotFoundError("sp");
    };
    const adapter = createSocialPosterProvider({ spawnImpl });
    const probe = await adapter.available();
    expect(probe.available).toBe(false);
    expect(probe.reason).toMatch(/npm install -g @profullstack\/social-poster/);
  });
});

describe("createSocialPosterProvider.post", () => {
  it("happy path: parses a 2-row JSON array stdout into SocialResult rows", async () => {
    const spawnImpl: SpawnLike = async () =>
      ok(
        JSON.stringify([
          { platform: "x", success: true, url: "https://x.com/u/1", id: "1" },
          { platform: "linkedin", success: true, url: "https://linkedin.com/posts/2", id: "2" },
        ])
      );
    const adapter = createSocialPosterProvider({ spawnImpl });
    const result = await adapter.post(basePost);
    expect(result.backend).toBe("social-poster");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ platform: "x", success: true, postUrl: "https://x.com/u/1" });
    expect(result.rows[1]).toMatchObject({ platform: "linkedin", success: true, postId: "2" });
  });

  it("CLI exit nonzero with no stdout rows: every platform gets success:false + errorCode", async () => {
    const spawnImpl: SpawnLike = async () => fail("rate limit exceeded", 1);
    const adapter = createSocialPosterProvider({ spawnImpl });
    const result = await adapter.post(basePost);
    expect(result.rows).toHaveLength(2);
    for (const row of result.rows) {
      expect(row.success).toBe(false);
      expect(row.errorCode).toBe("rate-limited");
      expect(row.error).toMatch(/rate limit/);
    }
  });

  it("caption with shell metacharacters: post() writes a tempfile and uses --text-file", async () => {
    let observedArgs: ReadonlyArray<string> = [];
    let textFilePath: string | undefined;
    let textFileExisted = false;
    let textFileContent: string | undefined;
    const spawnImpl: SpawnLike = async (args) => {
      observedArgs = args;
      // Capture the tempfile path + contents BEFORE the post() finally
      // block unlinks it.
      const idx = args.indexOf("--text-file");
      if (idx !== -1) {
        textFilePath = args[idx + 1];
        if (textFilePath) {
          textFileExisted = existsSync(textFilePath);
          if (textFileExisted) {
            textFileContent = readFileSync(textFilePath, "utf8");
          }
        }
      }
      return ok(JSON.stringify([{ platform: "x", success: true, url: "https://x.com/u/1", id: "1" }]));
    };
    const adapter = createSocialPosterProvider({ spawnImpl });
    const result = await adapter.post({
      ventureSlug: "demo",
      text: 'Dogs & cats "love" tech.\nCheck it out.',
      platforms: ["x"],
    });
    expect(observedArgs).toContain("--text-file");
    expect(observedArgs).not.toContain("--text");
    expect(textFileExisted).toBe(true);
    expect(textFileContent).toBe('Dogs & cats "love" tech.\nCheck it out.');
    expect(result.rows[0]?.success).toBe(true);
    // The post() finally block must remove the temp directory after spawn.
    if (textFilePath) {
      expect(existsSync(textFilePath)).toBe(false);
    }
  });

  it("plain-ascii caption: post() still rides on --text (no tempfile cost)", async () => {
    let observedArgs: ReadonlyArray<string> = [];
    const spawnImpl: SpawnLike = async (args) => {
      observedArgs = args;
      return ok(JSON.stringify([{ platform: "x", success: true, url: "https://x.com/u/1", id: "1" }]));
    };
    const adapter = createSocialPosterProvider({ spawnImpl });
    await adapter.post({
      ventureSlug: "demo",
      text: "Launching today.",
      platforms: ["x"],
    });
    expect(observedArgs).toContain("--text");
    expect(observedArgs).not.toContain("--text-file");
  });

  it("scheduleAt with social-poster: fast path returns scheduled-not-supported rows without spawning", async () => {
    let spawnCalled = 0;
    const spawnImpl: SpawnLike = async () => {
      spawnCalled++;
      return ok("[]");
    };
    const adapter = createSocialPosterProvider({ spawnImpl });
    const result = await adapter.post({ ...basePost, scheduleAt: "2026-06-01T10:00:00.000Z" });
    expect(spawnCalled).toBe(0);
    expect(result.rows.every((r) => r.errorCode === "scheduled-not-supported")).toBe(true);
  });
});

describe("argv builders + grouping", () => {
  it("buildSpPostArgs: text + media + platforms become a deterministic argv", () => {
    expect(
      buildSpPostArgs({
        text: "hi",
        mediaPaths: ["/abs/path/a.mp4", "/abs/path/b.png"],
        platforms: ["x", "bluesky"],
      })
    ).toEqual([
      "post",
      "--json",
      "--text",
      "hi",
      "--media",
      "/abs/path/a.mp4",
      "--media",
      "/abs/path/b.png",
      "--platforms",
      "x,bluesky",
    ]);
  });

  it("buildSpPostArgs: textFile path uses --text-file and never emits --text", () => {
    const args = buildSpPostArgs({
      textFile: "/abs/tmp/caption.txt",
      mediaPaths: [],
      platforms: ["x"],
    });
    expect(args).toEqual([
      "post",
      "--json",
      "--text-file",
      "/abs/tmp/caption.txt",
      "--platforms",
      "x",
    ]);
    expect(args).not.toContain("--text");
  });

  it("captionNeedsTextFile: plain ascii captions ride on argv", () => {
    expect(captionNeedsTextFile("Launching today.")).toBe(false);
    expect(captionNeedsTextFile("Check out https://example.com")).toBe(false);
  });

  it("captionNeedsTextFile: shell metas / newlines force a tempfile", () => {
    expect(captionNeedsTextFile("dogs & cats")).toBe(true);
    expect(captionNeedsTextFile('say "hi"')).toBe(true);
    expect(captionNeedsTextFile("line one\nline two")).toBe(true);
    expect(captionNeedsTextFile("pipe | redirect > out")).toBe(true);
  });

  it("groupPlatformsByOverride: same effective text -> single batch", () => {
    const batches = groupPlatformsByOverride(basePost);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.platforms).toEqual(["x", "linkedin"]);
  });

  it("groupPlatformsByOverride: per-platform override splits into separate batches", () => {
    const batches = groupPlatformsByOverride({
      ...basePost,
      perPlatformOverrides: {
        x: { text: "punchy x" },
        linkedin: { hashtags: ["launch"] },
      },
    });
    // x has overridden text, linkedin gets base text + hashtag.
    // Three distinct effective texts -> three batches? No: x and linkedin
    // both differ from each other AND from the base, but base isn't used
    // by either platform, so two batches total.
    expect(batches).toHaveLength(2);
  });

  it("trimToLongestCap: text under cap is returned unchanged", () => {
    expect(trimToLongestCap("short", ["x"])).toBe("short");
  });

  it("trimToLongestCap: x's 280-char cap trims with ellipsis", () => {
    const long = "a".repeat(500);
    const trimmed = trimToLongestCap(long, ["x"]);
    expect(trimmed.length).toBe(280);
    expect(trimmed.endsWith("...")).toBe(true);
  });
});
