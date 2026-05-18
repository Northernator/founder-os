import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  draftFilename,
  getSocialDir,
  getSocialDraftDir,
  getSocialPostsDir,
  readPostLog,
  resultFilename,
  slugForFilename,
  writeDraft,
  writeResult,
} from "../src/paths.js";
import type { SocialPost, SocialResult } from "@founder-os/social-core";

describe("path helpers", () => {
  it("getSocialDir + getSocialDraftDir + getSocialPostsDir use 13_social/", () => {
    const root = "/abs/venture";
    expect(getSocialDir(root)).toBe(join(root, "13_social"));
    expect(getSocialDraftDir(root)).toBe(join(root, "13_social", "drafts"));
    expect(getSocialPostsDir(root)).toBe(join(root, "13_social", "posts"));
  });

  it("slugForFilename strips, lowercases, caps at 32, falls back to 'post'", () => {
    expect(slugForFilename("Launching today!!!")).toBe("launching-today");
    expect(slugForFilename("!!!")).toBe("post");
    expect(slugForFilename("a".repeat(50)).length).toBe(32);
  });

  it("draftFilename + resultFilename produce filesystem-safe names", () => {
    expect(draftFilename("2026-05-15T08:00:00.000Z", "Hello world")).toBe(
      "2026-05-15T08-00-00.000Z-hello-world.draft.json"
    );
    expect(resultFilename("2026-05-15T08:00:00.000Z", "x")).toBe(
      "2026-05-15T08-00-00.000Z-x.result.json"
    );
  });
});

describe("draft + result round-trip in tmpdir", () => {
  let venture: string;
  beforeEach(async () => {
    venture = await mkdtemp(join(tmpdir(), "social-providers-paths-"));
  });
  afterEach(async () => {
    await rm(venture, { recursive: true, force: true });
  });

  it("writeDraft + writeResult + readPostLog round-trip", async () => {
    const ts = "2026-05-15T09:00:00.000Z";
    const draft: SocialPost = {
      ventureSlug: "demo",
      text: "Launching today",
      platforms: ["x", "linkedin"],
    };
    const result: SocialResult = {
      ventureSlug: "demo",
      backend: "social-poster",
      postedAt: ts,
      rows: [
        {
          platform: "x",
          success: true,
          postUrl: "https://x.com/u/1",
          timestamp: ts,
        },
      ],
    };

    const draftPath = await writeDraft(venture, draft, ts);
    expect(draftPath).toMatch(/13_social.*drafts.*draft\.json$/);

    const resultPath = await writeResult(venture, result, ts);
    expect(resultPath).toMatch(/13_social.*posts.*result\.json$/);

    const log = await readPostLog(venture);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      backend: "social-poster",
      ventureSlug: "demo",
    });
  });

  it("readPostLog returns [] when posts dir does not exist", async () => {
    const log = await readPostLog(venture);
    expect(log).toEqual([]);
  });
});
