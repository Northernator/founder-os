// Parsers for social-poster's --json stdout shapes.
//
// social-poster's --json output is per-row: one JSON object per
// platform per attempt. We tolerate both:
//   - a JSON array of rows  (sp >=v0.x: `[{...}, {...}]`)
//   - one row per line       (sp older builds: NDJSON)
// The adapter treats either as authoritative; if neither parses, every
// platform in the batch gets a row with errorCode "unknown".
//
// Status output (sp status --json) is a single object mapping platform
// names to status strings ("logged in", "logged out", "unknown").
// Missing entries map to "unknown".

import type {
  SocialLoginState,
  SocialLoginStateValue,
  SocialPlatform,
  SocialResultRow,
} from "@founder-os/social-core";
import type { SocialPosterSpawnResult } from "./spawn.js";

// ---------------------------------------------------------------------------
// Status parser
// ---------------------------------------------------------------------------

/**
 * Map sp status --json stdout into our SocialLoginState. Tolerant:
 * unknown stdout shape returns {} so the desktop UI shows every
 * platform as "unknown".
 */
export function mapSpStatusToLoginState(stdout: string): SocialLoginState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim() || "{}");
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const out: SocialLoginState = {};
  for (const [key, value] of Object.entries(parsed)) {
    const platform = normalizePlatformName(key);
    if (!platform) continue;
    out[platform] = normalizeLoginStateValue(value);
  }
  return out;
}

/**
 * Per-row parse. Accepts a SpawnResult (so we can branch on exit code +
 * stderr without re-parsing) and returns one SocialResultRow per
 * platform in `platforms`. Unknown platforms in the stdout are dropped;
 * platforms in `platforms` not represented in the stdout get a synthetic
 * "unknown" row so the caller's UI always has a row per platform.
 */
export function parseSpPostStdout(
  spawnResult: SocialPosterSpawnResult,
  platforms: ReadonlyArray<SocialPlatform>
): SocialResultRow[] {
  const ts = new Date().toISOString();
  const stdoutRows = parseAnyShape(spawnResult.stdout);
  // Index by platform for quick lookup.
  const indexed = new Map<SocialPlatform, RawRow>();
  for (const raw of stdoutRows) {
    const platform = normalizePlatformName(raw.platform);
    if (platform) indexed.set(platform, raw);
  }

  const rows: SocialResultRow[] = [];
  for (const platform of platforms) {
    const raw = indexed.get(platform);
    if (!raw) {
      // sp didn't emit a row for this platform -- treat as failure with
      // a structured code so the desktop UI can surface a retry CTA.
      const failed = spawnResult.code !== 0;
      rows.push({
        platform,
        success: false,
        error: failed
          ? `sp exit ${spawnResult.code}: ${spawnResult.stderr.slice(0, 200).trim()}`
          : "no row in sp stdout for this platform",
        errorCode: detectErrorCode(spawnResult.stderr),
        timestamp: ts,
      });
      continue;
    }
    rows.push({
      platform,
      success: raw.success === true,
      postUrl: typeof raw.url === "string" ? raw.url : undefined,
      postId: typeof raw.id === "string" ? raw.id : undefined,
      error: typeof raw.error === "string" ? raw.error : undefined,
      errorCode:
        raw.success === true
          ? undefined
          : detectErrorCode(raw.error ?? spawnResult.stderr),
      timestamp:
        typeof raw.timestamp === "string" ? raw.timestamp : ts,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type RawRow = {
  platform?: string;
  success?: unknown;
  url?: unknown;
  id?: unknown;
  error?: string;
  timestamp?: unknown;
};

function parseAnyShape(stdout: string): RawRow[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];
  // Try array form first.
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (x): x is RawRow => typeof x === "object" && x !== null
      );
    }
    if (typeof parsed === "object" && parsed !== null) {
      // Single-object form.
      return [parsed as RawRow];
    }
  } catch {
    // fall through to NDJSON
  }
  // NDJSON: one JSON object per line.
  const rows: RawRow[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (l.length === 0) continue;
    try {
      const parsed = JSON.parse(l);
      if (typeof parsed === "object" && parsed !== null) {
        rows.push(parsed as RawRow);
      }
    } catch {
      // skip malformed line
    }
  }
  return rows;
}

const PLATFORM_ALIASES: Record<string, SocialPlatform> = {
  x: "x",
  twitter: "x",
  instagram: "instagram",
  ig: "instagram",
  linkedin: "linkedin",
  facebook: "facebook",
  fb: "facebook",
  tiktok: "tiktok",
  youtube: "youtube",
  yt: "youtube",
  threads: "threads",
  bluesky: "bluesky",
  bsky: "bluesky",
  mastodon: "mastodon",
  reddit: "reddit",
  pinterest: "pinterest",
};

function normalizePlatformName(value: unknown): SocialPlatform | null {
  if (typeof value !== "string") return null;
  const k = value.toLowerCase().trim();
  return PLATFORM_ALIASES[k] ?? null;
}

function normalizeLoginStateValue(value: unknown): SocialLoginStateValue {
  if (typeof value === "boolean") {
    return value ? "logged_in" : "logged_out";
  }
  if (typeof value !== "string") return "unknown";
  const k = value.toLowerCase().trim();
  if (
    k === "logged_in" ||
    k === "logged in" ||
    k === "ok" ||
    k === "active"
  ) {
    return "logged_in";
  }
  if (
    k === "logged_out" ||
    k === "logged out" ||
    k === "expired" ||
    k === "missing"
  ) {
    return "logged_out";
  }
  return "unknown";
}

const RATE_LIMIT_PATTERNS =
  /rate.?limit|too many requests|429|retry.after|throttl/i;
const NOT_LOGGED_IN_PATTERNS =
  /not.?logged.?in|session.?expired|please.?log.?in|401|unauthor/i;
const MEDIA_REJECTED_PATTERNS =
  /media (too large|invalid|rejected|unsupported)|file.too.large|aspect.ratio/i;
const PLATFORM_DOWN_PATTERNS = /503|service unavailable|gateway|temporar/i;

/**
 * Map free-text error strings to the structured errorCode enum.
 * Defensive against drift -- adds new patterns as social-poster
 * surfaces them.
 */
export function detectErrorCode(
  message: string | undefined
): SocialResultRow["errorCode"] {
  if (!message) return "unknown";
  if (RATE_LIMIT_PATTERNS.test(message)) return "rate-limited";
  if (NOT_LOGGED_IN_PATTERNS.test(message)) return "not-logged-in";
  if (MEDIA_REJECTED_PATTERNS.test(message)) return "media-rejected";
  if (PLATFORM_DOWN_PATTERNS.test(message)) return "platform-down";
  return "unknown";
}
