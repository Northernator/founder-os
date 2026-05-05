import {
  type NamingCandidate,
  type NamingScan,
  NamingScanSchema,
  createEmptyCandidate,
  createEmptyNamingScan,
} from "@founder-os/branding-core";
import type { VentureManifest } from "@founder-os/domain";
/**
 * Naming candidate generator — invoked from the Brand tab's "AI generate
 * names" button. Takes a `callLlm` caller (injected so pipeline-runner
 * stays provider-agnostic), prompts the model for a JSON block of
 * candidates, parses it, and writes the resulting `NamingScan` to
 * `03_brand/names/name-candidates.json`.
 *
 * Behaviour
 * ---------
 *  - If the file already exists we load it, merge new candidates by name
 *    (case-insensitive) and write the merged scan. Rerunning never drops
 *    availability checks the founder has already run on old candidates.
 *  - The LLM is asked for a fenced \`\`\`json block (mirrors the prompt
 *    in `brandStagePrompt`). If the model fumbles and emits bare JSON or
 *    an unfenced block we fall back through two regex matchers before
 *    failing.
 *  - A Zod parse guards every candidate — a malformed row is dropped
 *    with a log entry rather than corrupting the whole scan.
 *
 * The matching cue (`NAMING_CANDIDATES_READY`) is produced by the
 * chat-side system prompt; this step is the "do it now" path the Brand
 * tab uses when the user clicks the button directly.
 */
import { createLogger } from "@founder-os/logger";
import { getBrandNamesDir } from "@founder-os/workspace-core";
import type { Filesystem } from "../fs.js";

const log = createLogger("pipeline-runner:generate-naming-candidates");

const CANDIDATES_FILENAME = "name-candidates.json";

/**
 * Minimal LLM caller — same shape as `SaasLlmCaller` from the research
 * reports step. Kept local so the two steps stay independent (we might
 * change the signature of one without touching the other).
 */
export type NamingLlmCaller = (prompt: {
  system: string;
  user: string;
}) => Promise<string>;

export type GenerateNamingCandidatesContext = {
  fs: Filesystem;
  manifest: VentureManifest;
  ventureRoot: string;
  callLlm: NamingLlmCaller;
  /**
   * Optional user seeds / hints to bias the candidates. Could be the
   * founder's existing shortlist, keywords, or an "avoid these" list.
   * Concatenated into the user prompt verbatim.
   */
  seedHints?: string;
  /** How many candidates to request. Default 8 (the prompt asks 5-10). */
  targetCount?: number;
};

export type GenerateNamingCandidatesResult = {
  status: "done" | "partial" | "failed";
  scanPath: string;
  /** Candidates added by THIS run — not the merged total. */
  added: NamingCandidate[];
  /** Total candidates in the scan post-merge. */
  total: number;
  /** Human-readable note — e.g. "dropped 1 malformed candidate". */
  note?: string;
};

const SYSTEM_PROMPT = `You are a brand strategist generating venture name candidates. Return a fenced \`\`\`json block with the exact shape:

{
  "candidates": [
    {
      "name": "string",
      "style": "compound | invented | descriptive | metaphor | acronym | personal",
      "rationale": "1-2 sentences explaining the mental hook / etymology / why this lands"
    }
  ]
}

Rules:
- Mix naming styles — at least 3 distinct styles across the set.
- Names must be 3-14 characters, single word preferred, no spaces or punctuation.
- Avoid obvious trademark collisions with well-known brands.
- UK context: don't clash with common UK retail / fintech names.
- Rationale is concrete, not marketing fluff.

Return ONLY the JSON block. No preamble, no commentary.`;

function buildUserPrompt(ctx: GenerateNamingCandidatesContext): string {
  const count = ctx.targetCount ?? 8;
  const m = ctx.manifest;
  const lines = [
    `Generate ${count} name candidates for this venture.`,
    "",
    `**Venture:** ${m.name}`,
    `**App type:** ${m.appType}`,
    `**Industry:** ${m.industry ?? "general"}`,
    `**Regulated:** ${m.regulated ? "yes" : "no"}`,
    `**Takes payments:** ${m.takesPayments ? "yes" : "no"}`,
  ];
  if (m.blockers.length > 0) {
    lines.push(`**Known blockers:** ${m.blockers.join(", ")}`);
  }
  if (ctx.seedHints?.trim()) {
    lines.push("", "### Founder hints", ctx.seedHints.trim());
  }
  lines.push("", `Return ${count} candidates. JSON only.`);
  return lines.join("\n");
}

/**
 * Parse a raw LLM response into an array of candidate dicts. Tries, in
 * order:
 *   1. Fenced ```json block (what the prompt asked for)
 *   2. Any fenced ``` block containing a JSON object
 *   3. The first `{...}` in the response
 *
 * Throws on all three failures. Caller wraps in try/catch.
 */
function extractCandidatesJson(raw: string): unknown {
  const text = raw.trim();
  const fenced = /```json\s*\n([\s\S]*?)\n```/i.exec(text) || /```\s*\n([\s\S]*?)\n```/i.exec(text);
  if (fenced?.[1]) {
    return JSON.parse(fenced[1]);
  }
  const brace = /(\{[\s\S]*\})/.exec(text);
  if (brace?.[1]) {
    return JSON.parse(brace[1]);
  }
  throw new Error("No JSON object found in LLM response");
}

export async function generateNamingCandidatesStep(
  ctx: GenerateNamingCandidatesContext
): Promise<GenerateNamingCandidatesResult> {
  const dir = getBrandNamesDir(ctx.ventureRoot);
  await ctx.fs.mkdir(dir);
  const scanPath = `${dir}/${CANDIDATES_FILENAME}`;

  // Load existing scan if present — avoid clobbering availability checks
  // the founder has already run.
  let scan: NamingScan;
  if (await ctx.fs.exists(scanPath)) {
    try {
      const raw = await ctx.fs.readFile(scanPath);
      scan = NamingScanSchema.parse(JSON.parse(raw));
      log.info(`Loaded existing scan with ${scan.candidates.length} candidate(s)`);
    } catch (err) {
      log.warn(`Existing scan was corrupt, starting fresh: ${errMsg(err)}`);
      scan = createEmptyNamingScan(ctx.manifest.id);
    }
  } else {
    scan = createEmptyNamingScan(ctx.manifest.id);
  }

  // Call the model.
  let raw: string;
  try {
    raw = await ctx.callLlm({
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(ctx),
    });
  } catch (err) {
    log.error(`LLM call failed: ${errMsg(err)}`);
    return {
      status: "failed",
      scanPath,
      added: [],
      total: scan.candidates.length,
      note: `LLM call failed: ${errMsg(err)}`,
    };
  }

  // Parse.
  let parsed: unknown;
  try {
    parsed = extractCandidatesJson(raw);
  } catch (err) {
    log.error(`Couldn't parse LLM response: ${errMsg(err)}`);
    return {
      status: "failed",
      scanPath,
      added: [],
      total: scan.candidates.length,
      note: `Parse error: ${errMsg(err)}`,
    };
  }

  const rawCandidates: Record<string, unknown>[] =
    typeof parsed === "object" &&
    parsed !== null &&
    "candidates" in parsed &&
    Array.isArray((parsed as { candidates: unknown }).candidates)
      ? (parsed as { candidates: Record<string, unknown>[] }).candidates
      : [];

  if (rawCandidates.length === 0) {
    return {
      status: "failed",
      scanPath,
      added: [],
      total: scan.candidates.length,
      note: "Model returned zero candidates",
    };
  }

  // Existing names for dedup (case-insensitive). Rerunning intentionally
  // adds *new* candidates without duplicating existing ones.
  const existingNames = new Set(scan.candidates.map((c) => c.name.trim().toLowerCase()));

  const added: NamingCandidate[] = [];
  let dropped = 0;
  for (const rc of rawCandidates) {
    const name = typeof rc.name === "string" ? rc.name.trim() : "";
    if (!name || name.length < 2 || name.length > 32) {
      dropped++;
      continue;
    }
    if (existingNames.has(name.toLowerCase())) {
      // Silent dedup — founder regenerated, same name came back.
      continue;
    }
    const rationale = typeof rc.rationale === "string" ? rc.rationale.trim() : "";
    const style = typeof rc.style === "string" ? rc.style.trim() : undefined;
    const candidate = createEmptyCandidate({ name, rationale, style });
    added.push(candidate);
    existingNames.add(name.toLowerCase());
  }

  if (added.length === 0) {
    return {
      status: "failed",
      scanPath,
      added: [],
      total: scan.candidates.length,
      note: dropped
        ? `All ${dropped} candidate(s) failed validation or were duplicates`
        : "No new candidates — all were duplicates of existing ones",
    };
  }

  // Merge and persist.
  const now = new Date().toISOString();
  scan.candidates = [...scan.candidates, ...added];
  scan.updatedAt = now;

  await ctx.fs.writeFile(scanPath, `${JSON.stringify(scan, null, 2)}\n`);
  log.info(`Wrote ${scanPath} — added ${added.length}, total ${scan.candidates.length}`);

  const status: "done" | "partial" = dropped > 0 ? "partial" : "done";
  return {
    status,
    scanPath,
    added,
    total: scan.candidates.length,
    note: dropped > 0 ? `Dropped ${dropped} malformed candidate(s)` : undefined,
  };
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
