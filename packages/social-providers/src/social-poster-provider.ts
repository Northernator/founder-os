/**
 * social-poster SocialAdapter -- TIER_0.
 *
 * Drives the @profullstack/social-poster CLI (`sp`). Per spec sec 6:
 *   - available()    Probe the binary via PATH (`sp --version`).
 *   - loginState()   `sp status --json` -- mirror per-platform login
 *                    cookies into our SocialPlatform enum.
 *   - post()         For each batch of platforms (split by per-platform
 *                    overrides), spawn `sp post --json --text "..."
 *                    [--media <path>] --platforms x,linkedin`. Parse
 *                    structured rows out of stdout.
 *
 * Spawn is dependency-injected via SpawnLike so the vitest suite never
 * actually shells out. Same precedent as supabase-provider's FetchLike
 * injection in @founder-os/backend-providers.
 *
 * scheduleAt is rejected at validate-time -- social-poster doesn't
 * support scheduling natively. Callers that want scheduling use the
 * postiz adapter instead (or schedule the OS task themselves via the
 * `schedule` skill).
 */

import {
  SOCIAL_PLATFORM_CAPTION_CAPS,
  type SocialAdapter,
  type SocialAvailability,
  type SocialLoginState,
  type SocialPlatform,
  type SocialPost,
  type SocialResult,
  type SocialResultRow,
} from "@founder-os/social-core";

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  spawnSp,
  SocialPosterNotFoundError,
  type SocialPosterSpawnResult,
  type SpawnLike,
} from "./spawn.js";
import { mapSpStatusToLoginState, parseSpPostStdout } from "./social-poster-parse.js";

// ---------------------------------------------------------------------------
// Options + factory
// ---------------------------------------------------------------------------

export type CreateSocialPosterProviderOpts = {
  /**
   * CLI binary name or absolute path. Defaults to "sp" -- discovered
   * via PATH. Override to pin to a specific install when multiple Node
   * toolchains are present.
   */
  binary?: string;
  /**
   * Hard timeout per spawn. Defaults to 5 minutes -- video uploads can
   * take a while.
   */
  timeoutMs?: number;
  /**
   * Spawn implementation. Production callers omit this; tests inject a
   * stubbed SpawnLike that returns canned stdout/stderr/code without
   * touching node:child_process.
   */
  spawnImpl?: SpawnLike;
};

/**
 * Build a real social-poster SocialAdapter. Pure construction --
 * available() / loginState() / post() are the side-effecting methods.
 */
export function createSocialPosterProvider(
  opts: CreateSocialPosterProviderOpts = {}
): SocialAdapter {
  const binary = opts.binary ?? "sp";
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const doSpawn: SpawnLike = opts.spawnImpl ?? spawnSp;

  return {
    name: "social-poster",

    async available(): Promise<SocialAvailability> {
      try {
        const r = await doSpawn(["--version"], { binary, timeoutMs: 10_000 });
        if (r.code === 0) return { available: true };
        return {
          available: false,
          reason: `sp --version exited ${r.code}: ${r.stderr.slice(0, 120).trim()}`,
        };
      } catch (err) {
        if (err instanceof SocialPosterNotFoundError) {
          return {
            available: false,
            reason:
              "sp CLI not found on PATH. Install with `npm install -g @profullstack/social-poster`.",
          };
        }
        return {
          available: false,
          reason: `sp probe failed: ${(err as Error).message}`,
        };
      }
    },

    async loginState(): Promise<SocialLoginState> {
      try {
        const r = await doSpawn(["status", "--json"], {
          binary,
          timeoutMs: 15_000,
        });
        if (r.code !== 0) return {};
        return mapSpStatusToLoginState(r.stdout);
      } catch {
        // Status failures are non-fatal -- the desktop UI just shows
        // "unknown" for every platform.
        return {};
      }
    },

    async post(payload: SocialPost): Promise<SocialResult> {
      const postedAt = new Date().toISOString();

      // Fast path: scheduleAt isn't supported. Return a row per platform
      // so the desktop UI can surface why nothing posted.
      if (payload.scheduleAt) {
        return {
          ventureSlug: payload.ventureSlug,
          backend: "social-poster",
          postedAt,
          rows: payload.platforms.map<SocialResultRow>((platform) => ({
            platform,
            success: false,
            error:
              "social-poster does not support scheduled posts. Use the postiz backend, or schedule the OS task via the `schedule` skill.",
            errorCode: "scheduled-not-supported",
            timestamp: postedAt,
          })),
          rawAdapterPayload: { skipped: "scheduled-not-supported" },
        };
      }

      // Group platforms by override fingerprint so platforms sharing the
      // same effective text/hashtags get a single sp invocation. Most
      // ventures have either zero overrides (one batch) or per-platform
      // overrides for every platform (one batch per platform).
      const batches = groupPlatformsByOverride(payload);
      const rows: SocialResultRow[] = [];
      const rawCaptures: unknown[] = [];

      for (const batch of batches) {
        const text = trimToLongestCap(batch.text, batch.platforms);
        // Captions that contain shell metacharacters (or newlines, common in
        // launch-announcement boilerplate) cannot ride on argv on Windows --
        // Node 20+ refuses to spawn .cmd shims with such args (BatBadBut /
        // CVE-2024-24576) even when we resolve shell:true. Falling back to a
        // tempfile + `--text-file <path>` keeps the spawn metacharacter-free
        // everywhere AND closes the residual argv-injection surface on POSIX.
        // The file lives under os.tmpdir(); we unlink in `finally` so we don't
        // leak captions to disk.
        let textFile: string | undefined;
        let tempDir: string | undefined;
        if (captionNeedsTextFile(text)) {
          tempDir = mkdtempSync(join(tmpdir(), "founderos-sp-"));
          textFile = join(tempDir, "caption.txt");
          writeFileSync(textFile, text, "utf8");
        }
        const args = buildSpPostArgs({
          text: textFile ? undefined : text,
          textFile,
          mediaPaths: (payload.media ?? []).map((m) => m.path),
          platforms: batch.platforms,
        });
        let spawnResult: SocialPosterSpawnResult;
        try {
          spawnResult = await doSpawn(args, { binary, timeoutMs });
        } catch (err) {
          const msg = (err as Error).message;
          const code: SocialResultRow["errorCode"] =
            err instanceof SocialPosterNotFoundError
              ? "not-logged-in"
              : "unknown";
          for (const platform of batch.platforms) {
            rows.push({
              platform,
              success: false,
              error: msg,
              errorCode: code,
              timestamp: new Date().toISOString(),
            });
          }
          continue;
        } finally {
          // Best-effort cleanup. We deliberately do NOT bubble cleanup errors
          // up -- an orphaned tempfile under os.tmpdir() is a 200-byte cost
          // and gets reaped by the OS reboot; failing the post just because
          // unlink raced with an antivirus scan would be a strictly worse UX.
          if (tempDir) {
            try {
              rmSync(tempDir, { recursive: true, force: true });
            } catch {
              /* swallow */
            }
          }
        }
        rawCaptures.push({
          batchPlatforms: batch.platforms,
          stdout: spawnResult.stdout,
          stderr: spawnResult.stderr,
          code: spawnResult.code,
        });
        const parsed = parseSpPostStdout(spawnResult, batch.platforms);
        rows.push(...parsed);
      }

      return {
        ventureSlug: payload.ventureSlug,
        backend: "social-poster",
        postedAt,
        rows,
        rawAdapterPayload: rawCaptures,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type PostBatch = {
  text: string;
  platforms: SocialPlatform[];
};

/**
 * Group platforms by the effective text after applying per-platform
 * overrides. Platforms sharing the same effective text share a single
 * sp invocation.
 */
export function groupPlatformsByOverride(payload: SocialPost): PostBatch[] {
  const overrides = payload.perPlatformOverrides ?? {};
  const buckets = new Map<string, PostBatch>();
  for (const platform of payload.platforms) {
    const override = overrides[platform];
    const baseText = override?.text ?? payload.text;
    const hashtags = override?.hashtags ?? [];
    const text =
      hashtags.length === 0
        ? baseText
        : `${baseText} ${hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")}`;
    const key = text;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.platforms.push(platform);
    } else {
      buckets.set(key, { text, platforms: [platform] });
    }
  }
  return [...buckets.values()];
}

/**
 * Trim the resolved text to the longest cap of the platforms in the
 * batch. The adapter doesn't trim per-platform inside a batch -- a
 * batch is "platforms sharing the same text" by definition, so the
 * trim is the longest-supported limit. If the batch contains a
 * platform with a tighter cap, the per-platform override path should
 * have split it into its own batch already.
 */
export function trimToLongestCap(
  text: string,
  platforms: ReadonlyArray<SocialPlatform>
): string {
  let cap = 0;
  for (const platform of platforms) {
    const c = SOCIAL_PLATFORM_CAPTION_CAPS[platform];
    if (c > cap) cap = c;
  }
  if (cap === 0 || text.length <= cap) return text;
  return `${text.slice(0, cap - 3)}...`;
}

export type BuildSpPostArgs = {
  /**
   * Caption text passed inline via `--text`. Mutually exclusive with
   * `textFile`. When both are absent the function emits `--text ""` to
   * preserve sp's positional expectation.
   */
  text?: string;
  /**
   * Absolute path to a file containing the caption. Preferred over `text`
   * for any caption containing shell metacharacters or newlines -- on
   * Windows this is the ONLY safe way to spawn a `.cmd` shim without
   * tripping BatBadBut (CVE-2024-24576). The caller is responsible for
   * writing + cleaning up the file.
   */
  textFile?: string;
  mediaPaths: ReadonlyArray<string>;
  platforms: ReadonlyArray<SocialPlatform>;
};

/**
 * Build the argv list for `sp post --json`. Kept exported so the
 * vitest suite can assert on the exact shape.
 *
 * Branch order:
 *   1. `textFile`  -> `--text-file <abs>` (safe everywhere, no argv chars)
 *   2. `text`      -> `--text <verbatim>` (legacy path; only safe when the
 *                     caller has verified the caption has no shell metas)
 *   3. neither     -> `--text ""` (degenerate, kept for back-compat)
 */
export function buildSpPostArgs(args: BuildSpPostArgs): string[] {
  const out: string[] = ["post", "--json"];
  if (args.textFile) {
    out.push("--text-file", args.textFile);
  } else {
    out.push("--text", args.text ?? "");
  }
  for (const path of args.mediaPaths) {
    out.push("--media", path);
  }
  out.push("--platforms", args.platforms.join(","));
  return out;
}

/**
 * Captions containing any of these characters cannot ride on argv to a
 * Windows .cmd shim post-BatBadBut. We also flag newlines because pnpm's
 * raw cmd quoting collapses them, mangling multi-paragraph captions even
 * on POSIX systems where the binary itself is safe. Exported so vitest
 * can pin the trigger set.
 */
export function captionNeedsTextFile(text: string): boolean {
  // & | ^ < > " ' are the BatBadBut metacharacters. \r\n is added because
  // launch-announcement.md content is multi-line by default and cmd's
  // argv handling drops the second line.
  return /[&|^<>"'\r\n]/.test(text);
}
