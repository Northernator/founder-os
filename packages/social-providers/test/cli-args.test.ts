/**
 * Tests for the pure argv-parsing helpers extracted from cli.ts.
 *
 * Slice 7 of the SOCIAL-MODULE follow-up arc. Mirrors crm-providers'
 * cli-args.test.ts structure so drift-protection density stays consistent
 * across the providers stack.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseSocialPost } from "@founder-os/social-core";

import {
  flag,
  parseBackendFlag,
  parsePostizConfigFlags,
  required,
} from "../src/cli-args.js";

describe("flag()", () => {
  it("returns the value following the named flag", () => {
    expect(flag(["--backend", "postiz", "--ignored", "value"], "--backend")).toBe(
      "postiz",
    );
  });

  it("returns undefined when the flag is absent", () => {
    expect(flag(["--other", "x"], "--backend")).toBeUndefined();
  });

  it("returns undefined when the value position is another --flag", () => {
    // User wrote `--backend --postiz-base-url x` -- the value slot is
    // actually the next flag name, not a value. We treat that as missing.
    expect(flag(["--backend", "--postiz-base-url", "x"], "--backend")).toBeUndefined();
  });

  it("returns undefined when the flag is the final entry with no value", () => {
    expect(flag(["--backend"], "--backend")).toBeUndefined();
  });
});

describe("required()", () => {
  it("returns the value when present", () => {
    expect(required("postiz", "--backend")).toBe("postiz");
  });

  it("throws with the flag name when undefined", () => {
    expect(() => required(undefined, "--backend")).toThrow(/missing required argument --backend/);
  });

  it("throws on empty string -- the falsy check is intentional", () => {
    expect(() => required("", "--backend")).toThrow(/missing required argument --backend/);
  });
});

describe("parseBackendFlag()", () => {
  it("accepts every backend the CLI supports", () => {
    expect(parseBackendFlag(["--backend", "social-poster"])).toBe("social-poster");
    expect(parseBackendFlag(["--backend", "postiz"])).toBe("postiz");
    expect(parseBackendFlag(["--backend", "config_only"])).toBe("config_only");
  });

  it("rejects stub-only backends that exist in the enum but aren't CLI-surfaced", () => {
    expect(() => parseBackendFlag(["--backend", "brightbean"])).toThrow(/unsupported backend: brightbean/);
    expect(() => parseBackendFlag(["--backend", "trypost"])).toThrow(/unsupported backend: trypost/);
  });

  it("rejects free-form garbage with a typed error", () => {
    expect(() => parseBackendFlag(["--backend", "garbage"])).toThrow(/unsupported backend: garbage/);
  });

  it("throws when --backend is missing entirely", () => {
    expect(() => parseBackendFlag([])).toThrow(/missing required argument --backend/);
  });
});

describe("parsePostizConfigFlags()", () => {
  it("returns the documented defaults when no flags are passed", () => {
    expect(parsePostizConfigFlags([])).toEqual({
      baseUrl: "",
      apiKeyEnvVar: "POSTIZ_API_KEY",
      allowRemoteOnly: false,
    });
  });

  it("threads --postiz-base-url verbatim", () => {
    expect(
      parsePostizConfigFlags(["--postiz-base-url", "https://postiz.example.com"]),
    ).toMatchObject({ baseUrl: "https://postiz.example.com" });
  });

  it("threads --postiz-api-key-env verbatim", () => {
    expect(
      parsePostizConfigFlags(["--postiz-api-key-env", "MY_POSTIZ_KEY"]),
    ).toMatchObject({ apiKeyEnvVar: "MY_POSTIZ_KEY" });
  });

  it("flips allowRemoteOnly on --postiz-allow-remote-only", () => {
    expect(parsePostizConfigFlags(["--postiz-allow-remote-only"]).allowRemoteOnly).toBe(true);
  });

  it("ignores --postiz-allow-remote-only when absent", () => {
    expect(parsePostizConfigFlags(["--postiz-base-url", "x"]).allowRemoteOnly).toBe(false);
  });

  it("falls back to defaults for flags that point at another --flag", () => {
    // User wrote `--postiz-base-url --postiz-api-key-env FOO`. The base-url
    // value slot is actually the next flag, so we treat it as unset.
    const cfg = parsePostizConfigFlags([
      "--postiz-base-url",
      "--postiz-api-key-env",
      "FOO",
    ]);
    expect(cfg.baseUrl).toBe("");
    expect(cfg.apiKeyEnvVar).toBe("FOO");
  });
});

// ---------------------------------------------------------------------------
// --payload-file happy path: the CLI reads + parses a SocialPost JSON file.
// We exercise the read+parse path directly (the spawn+adapter side has its
// own test suite). This guards the file-IO + zod-parse boundary that the
// `post` subcommand depends on.
// ---------------------------------------------------------------------------

describe("--payload-file happy path", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "social-providers-cli-args-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a valid SocialPost JSON round-trips through parseSocialPost", () => {
    const file = join(dir, "payload.json");
    const payload = {
      ventureSlug: "demo",
      text: "Launching today.",
      platforms: ["x", "bluesky"],
    };
    writeFileSync(file, JSON.stringify(payload), "utf8");
    expect(existsSync(file)).toBe(true);

    const raw = JSON.parse(readFileSync(file, "utf8"));
    const parsed = parseSocialPost(raw);
    expect(parsed.ventureSlug).toBe("demo");
    expect(parsed.text).toBe("Launching today.");
    expect(parsed.platforms).toEqual(["x", "bluesky"]);
  });

  it("a payload missing required fields throws a typed zod issue", () => {
    const bogus = { ventureSlug: "demo" }; // missing text + platforms
    expect(() => parseSocialPost(bogus)).toThrow();
  });

  it("per-platform overrides survive the parse round-trip", () => {
    const payload = {
      ventureSlug: "demo",
      text: "Base caption.",
      platforms: ["x", "linkedin"],
      perPlatformOverrides: {
        x: { text: "punchy x" },
        linkedin: { hashtags: ["launch", "indiehackers"] },
      },
    };
    const parsed = parseSocialPost(payload);
    expect(parsed.perPlatformOverrides?.x?.text).toBe("punchy x");
    expect(parsed.perPlatformOverrides?.linkedin?.hashtags).toEqual([
      "launch",
      "indiehackers",
    ]);
  });
});
