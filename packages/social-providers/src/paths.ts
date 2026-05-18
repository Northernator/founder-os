// Per-venture path helpers + draft / result-log writers.
//
// Lives in social-providers (NOT @founder-os/workspace-core) because
// social posting is a STANDALONE UTILITY, not a pipeline stage --
// workspace-core is reserved for stage artifact paths. See
// bizBuild/SOCIAL-MODULE-SPEC.md sec 4.
//
// Folder layout under <ventureRoot>/13_social/:
//   social-config.json              -- effective config snapshot
//   drafts/<timestamp>-<slug>.draft.json
//   posts/<timestamp>-<slug>.result.json
//   README.md                       -- (slice 3 generates this)

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseSocialPost,
  parseSocialResult,
  type SocialPost,
  type SocialResult,
} from "@founder-os/social-core";

/** <ventureRoot>/13_social/ -- root for every social artifact. */
export function getSocialDir(ventureRoot: string): string {
  return join(ventureRoot, "13_social");
}

/** <ventureRoot>/13_social/drafts/ */
export function getSocialDraftDir(ventureRoot: string): string {
  return join(getSocialDir(ventureRoot), "drafts");
}

/** <ventureRoot>/13_social/posts/ */
export function getSocialPostsDir(ventureRoot: string): string {
  return join(getSocialDir(ventureRoot), "posts");
}

/** <ventureRoot>/13_social/scheduled/ -- queue for scheduled posts (slice 9). */
export function getSocialScheduledDir(ventureRoot: string): string {
  return join(getSocialDir(ventureRoot), "scheduled");
}

/**
 * Filename for a scheduled-post payload, sortable by fire time. Uses the
 * scheduleAt timestamp (filesystem-safe -- colons replaced) so a `ls`
 * listing shows the queue in firing order without extra metadata.
 */
export function scheduledPayloadFilename(scheduleAt: string, text: string): string {
  const ts = scheduleAt.replace(/[:]/g, "-");
  return `${ts}-${slugForFilename(text)}.payload.json`;
}

/** <ventureRoot>/13_social/social-config.json */
export function getSocialConfigPath(ventureRoot: string): string {
  return join(getSocialDir(ventureRoot), "social-config.json");
}

/**
 * Filename-safe slug derived from `text`. Strips everything that isn't
 * alphanumeric / dash / underscore, lowercases, and trims to 32 chars.
 * Falls back to "post" when the input slug would be empty.
 */
export function slugForFilename(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return cleaned.length > 0 ? cleaned : "post";
}

/**
 * Compute the on-disk filename for a draft. Combines an ISO-ish
 * timestamp (filesystem-safe -- colons replaced) with a slug derived
 * from the first line of the post text. Stable for a given (timestamp,
 * text) pair so callers can pre-compute the path before writing.
 */
export function draftFilename(timestamp: string, text: string): string {
  const ts = timestamp.replace(/[:]/g, "-");
  return `${ts}-${slugForFilename(text)}.draft.json`;
}

/**
 * Same shape as draftFilename, but for the result log under posts/.
 */
export function resultFilename(timestamp: string, text: string): string {
  const ts = timestamp.replace(/[:]/g, "-");
  return `${ts}-${slugForFilename(text)}.result.json`;
}

/**
 * Persist a SocialPost under drafts/. Returns the absolute path written.
 * mkdir -p semantics (recursive: true). Validates the payload via
 * parseSocialPost before writing -- a bad payload would otherwise
 * pollute the draft folder with un-readable JSON.
 */
export async function writeDraft(
  ventureRoot: string,
  payload: SocialPost,
  timestamp: string = new Date().toISOString()
): Promise<string> {
  const validated = parseSocialPost(payload);
  const dir = getSocialDraftDir(ventureRoot);
  await mkdir(dir, { recursive: true });
  const path = join(dir, draftFilename(timestamp, validated.text));
  await writeFile(path, JSON.stringify(validated, null, 2), "utf8");
  return path;
}

/**
 * Persist a SocialResult under posts/. Returns the absolute path
 * written. Validates the payload via parseSocialResult before writing.
 */
export async function writeResult(
  ventureRoot: string,
  result: SocialResult,
  timestamp: string = result.postedAt
): Promise<string> {
  const validated = parseSocialResult(result);
  const dir = getSocialPostsDir(ventureRoot);
  await mkdir(dir, { recursive: true });
  // Use the first row's platform name as the slug fallback when the
  // postedAt timestamp + result has no other discriminator. Combined
  // with the timestamp this is stable per attempt.
  const slugSeed =
    validated.rows[0]?.platform ?? validated.backend ?? "result";
  const path = join(dir, resultFilename(timestamp, slugSeed));
  await writeFile(path, JSON.stringify(validated, null, 2), "utf8");
  return path;
}

/**
 * Persist a SocialPost under scheduled/ for later firing. Returns the
 * absolute path written. Slice 9 of the SOCIAL-MODULE follow-up arc --
 * when a user sets payload.scheduleAt with backend === "social-poster"
 * (which doesn't support native scheduling), the CLI writes the payload
 * here instead of calling adapter.post() directly. A future scheduled
 * task (OS Task Scheduler, cron, or the Founder OS `schedule` skill)
 * picks the file back up and runs `social-providers post --payload-file
 * <abs>` at the target time.
 *
 * Validates via parseSocialPost so a malformed payload doesn't pollute
 * the queue.
 */
export async function writeScheduledPayload(
  ventureRoot: string,
  payload: SocialPost
): Promise<string> {
  const validated = parseSocialPost(payload);
  if (!validated.scheduleAt) {
    throw new Error("writeScheduledPayload: payload.scheduleAt is required");
  }
  const dir = getSocialScheduledDir(ventureRoot);
  await mkdir(dir, { recursive: true });
  const path = join(
    dir,
    scheduledPayloadFilename(validated.scheduleAt, validated.text),
  );
  await writeFile(path, JSON.stringify(validated, null, 2), "utf8");
  return path;
}

/**
 * Read every result file under posts/, in lexical (= chronological,
 * because filenames lead with ISO timestamps) order. Returns [] when
 * the directory doesn't exist yet -- a venture that's never posted
 * isn't an error. Rows that fail to parse are silently skipped (the
 * raw file remains on disk; the desktop UI surfaces a "could not parse
 * post log entry" notice in slice 3).
 */
export async function readPostLog(
  ventureRoot: string
): Promise<ReadonlyArray<SocialResult>> {
  const dir = getSocialPostsDir(ventureRoot);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return [];
    throw err;
  }
  const results: SocialResult[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".result.json")) continue;
    try {
      const raw = await readFile(join(dir, entry), "utf8");
      results.push(parseSocialResult(JSON.parse(raw)));
    } catch {
      // skip malformed entries; the file remains on disk for inspection.
    }
  }
  return results;
}
