/**
 * Naming-scan schemas for the Brand tab.
 *
 * Distinct from `naming.ts` (which models the simple LLM-generated name
 * suggestions used by the seed script). This file is about the full
 * availability-check lifecycle: for each candidate we track per-platform
 * status (domain / trademark / 6 social handles), derive a confidence
 * score from those, and persist the lot under
 * `03_brand/names/name-candidates.json`.
 *
 * Shape is designed for partial/incremental updates — a user can ask AI
 * to generate candidates (filling name + rationale + empty status slots),
 * then run availability checks per candidate which fill the status
 * fields in place. Every status value has an explicit `unknown` to
 * distinguish "not checked yet" from "checked, available".
 */
import { z } from "zod";

/**
 * Availability verdict for a single resource (domain, trademark, handle).
 *
 * - `available`  — confirmed unclaimed (DNS misses, 404 on handle, etc.)
 * - `taken`      — confirmed in use
 * - `parked`     — domain-specific: resolves to a parking page / for-sale
 * - `restricted` — some platforms (X, Instagram) return "challenge" pages
 *                  we can't reliably distinguish from `taken`. Treat as
 *                  "check manually" rather than pretending we know.
 * - `error`      — network failure / 429 rate limit / unexpected shape.
 *                  Caller should retry or manual-check.
 * - `unknown`    — never attempted.
 */
export const AvailabilityStatusSchema = z.enum([
  "available",
  "taken",
  "parked",
  "restricted",
  "error",
  "unknown",
]);
export type AvailabilityStatus = z.infer<typeof AvailabilityStatusSchema>;

/**
 * A single availability observation. `detail` is free-form text for the
 * UI to show on hover (HTTP status, error message, parking host, etc.).
 * `checkedAt` lets us show "checked 2h ago" and decide whether to rerun.
 */
export const AvailabilityCheckSchema = z.object({
  status: AvailabilityStatusSchema.default("unknown"),
  detail: z.string().optional(),
  /** ISO-8601. Omitted when status = "unknown". */
  checkedAt: z.string().optional(),
});
export type AvailabilityCheck = z.infer<typeof AvailabilityCheckSchema>;

/**
 * Six platforms we actively probe (pt.23 scope decision). Manual-only
 * platforms (e.g. LinkedIn company pages, Bluesky) can be added later;
 * each new entry needs a corresponding handler on the Rust side.
 *
 * Order matters for rendering — the Brand tab displays them in this
 * order and keeps the narrow column widths consistent across candidates.
 */
export const SOCIAL_PLATFORMS = [
  "x",
  "instagram",
  "tiktok",
  "threads",
  "github",
  "youtube",
] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export const SocialPlatformSchema = z.enum(SOCIAL_PLATFORMS);

/** Canonical display name per platform — used in the UI labels. */
export const SOCIAL_PLATFORM_LABELS: Record<SocialPlatform, string> = {
  x: "X / Twitter",
  instagram: "Instagram",
  tiktok: "TikTok",
  threads: "Threads",
  github: "GitHub",
  youtube: "YouTube",
};

/**
 * URL builders per platform — single source of truth so both the Rust
 * probe and the "open in browser" fallback stay consistent. Handles are
 * normalised to lowercase / no @ before insertion.
 *
 * YouTube uses `/@handle` (the post-2022 handle format) rather than
 * `/c/` or `/user/` — those are legacy paths and return 200 for anything
 * so they're useless for availability checks.
 */
export function socialProfileUrl(platform: SocialPlatform, handle: string): string {
  const h = handle.replace(/^@+/, "").toLowerCase();
  switch (platform) {
    case "x":
      return `https://x.com/${h}`;
    case "instagram":
      return `https://www.instagram.com/${h}/`;
    case "tiktok":
      return `https://www.tiktok.com/@${h}`;
    case "threads":
      return `https://www.threads.net/@${h}`;
    case "github":
      return `https://github.com/${h}`;
    case "youtube":
      return `https://www.youtube.com/@${h}`;
  }
}

/**
 * Trademark jurisdictions we surface as one-click search launchers.
 * pt.31b: extended to USPTO (US) and WIPO (Madrid Protocol global
 * search). The user reports back whether a hit exists — we don't scrape
 * because the result pages are JS-heavy and each office's terms forbid
 * automated lookup anyway.
 */
export const TRADEMARK_JURISDICTIONS = ["uk", "us", "wipo"] as const;
export type TrademarkJurisdiction = (typeof TRADEMARK_JURISDICTIONS)[number];

/**
 * Display labels for each jurisdiction, used in BrandTab buttons.
 */
export const TRADEMARK_JURISDICTION_LABELS: Record<TrademarkJurisdiction, string> = {
  uk: "UK IPO",
  us: "USPTO",
  wipo: "WIPO",
};

/**
 * Trademark search URL for a given term + jurisdiction. We don't scrape
 * — too fragile, and the official terms forbid it — so BrandTab opens
 * the URL in the default browser via `open_url` and the user reports
 * back. Each office has a public search form with a query parameter
 * we can pre-fill.
 */
export function trademarkSearchUrl(
  term: string,
  jurisdiction: TrademarkJurisdiction = "uk"
): string {
  const encoded = encodeURIComponent(term.trim());
  switch (jurisdiction) {
    case "uk":
      // UK IPO's public textual search. `?wordsearch=` pre-fills the
      // term; other params (class / status / etc.) fall to defaults
      // which is what we want for a first-pass lookup.
      return `https://trademarks.ipo.gov.uk/ipo-tmtext/Page/Result/2?wordsearch=${encoded}`;
    case "us":
      // USPTO TESS replacement (the new "Search trademark database"
      // tool launched late 2024). `?searchType=word` selects the word-
      // mark search, `q=` is the term. Other filter facets default to
      // "all live + dead, all classes" which is the right first pass.
      return `https://tmsearch.uspto.gov/search/search-information?searchType=word&q=${encoded}`;
    case "wipo":
      // WIPO Global Brand Database covers Madrid Protocol filings —
      // useful for "is this name globally registered?" The URL accepts
      // a `searchTerm=` parameter on the front page; results land in
      // the table below. Note: WIPO updates the URL structure
      // periodically; verify if the launcher stops working.
      return `https://branddb.wipo.int/branddb/en/?searchTerm=${encoded}`;
  }
}

/**
 * Domain suggestions we default to. The Brand tab surfaces these inline
 * with per-domain availability status — user can add more via a free
 * text field, and the `.co.uk` is listed because the project docs flag
 * the UK context as a hard constraint.
 */
export const DEFAULT_DOMAIN_TLDS = [".com", ".co.uk", ".io", ".app"] as const;

/**
 * A candidate name plus all the per-resource status slots. The `name`
 * is normalised client-side (trimmed, no trailing punctuation) before
 * being persisted, so downstream consumers can use it as-is.
 */
export const NamingCandidateSchema = z.object({
  /** Stable id — client generates a uuid so rerenders don't thrash. */
  id: z.string(),
  name: z.string(),
  /** Why the AI (or the founder) suggested this name. 1-2 sentences. */
  rationale: z.string().default(""),
  /** One of the naming styles from `naming.ts` — optional; purely informational. */
  style: z.string().optional(),

  // --- Availability slots ---

  /**
   * Keyed by full domain (`example.com`, `example.co.uk`). Populated
   * lazily — only TLDs the user actively checked have entries.
   */
  domainStatus: z.record(z.string(), AvailabilityCheckSchema).default({}),

  /**
   * Trademark status per jurisdiction. `uk` is the only live one today.
   * The check is a launcher — so status transitions go
   *   unknown → restricted (we opened the page, can't probe from here)
   * and the user then manually flips to available/taken.
   */
  trademarkStatus: z
    .record(z.string(), AvailabilityCheckSchema)
    .default({}),

  /** Keyed by platform id. */
  socialStatus: z
    .record(SocialPlatformSchema, AvailabilityCheckSchema)
    .default({}),

  /** Freeform note the founder can leave against this candidate. */
  notes: z.string().default(""),

  /** Timestamp of the most recent in-place edit to this candidate. */
  updatedAt: z.string(),
});
export type NamingCandidate = z.infer<typeof NamingCandidateSchema>;

/**
 * The on-disk shape at `03_brand/names/name-candidates.json`. Versioned
 * so we can evolve the schema without corrupting existing files. A
 * newer `version` reader can gracefully default unknown fields; older
 * readers should error out and ask the user to regenerate.
 */
export const NamingScanSchema = z.object({
  ventureId: z.string(),
  candidates: z.array(NamingCandidateSchema).default([]),
  /** Id of the candidate currently chosen as the venture name. */
  chosenCandidateId: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().default(1),
});
export type NamingScan = z.infer<typeof NamingScanSchema>;

// ---------------------------------------------------------------------------
// Confidence derivation
// ---------------------------------------------------------------------------

/**
 * Brand confidence traffic light — matches the project docs' vocabulary:
 *   green  = safe to proceed
 *   amber  = build but don't brand-lock yet
 *   red    = don't use
 *
 * Derived client-side from the candidate's status slots. Purely a UI
 * signal — persisted state is the status slots themselves, which lets
 * us recompute if the scoring rules change.
 */
export const BrandConfidenceSchema = z.enum(["green", "amber", "red", "unknown"]);
export type BrandConfidence = z.infer<typeof BrandConfidenceSchema>;

/**
 * Derive confidence from a candidate. Rules, in order:
 *
 *   - If `.com` is `taken`/`parked` OR any trademark hit → **red**
 *   - If any `error`/`restricted` status that hasn't been manually
 *     cleared → **amber** (we don't know, don't brand-lock)
 *   - If every checked slot is `available` → **green**
 *   - Otherwise (some availables, some uncheckeds) → **amber**
 *   - If no slot has ever been checked → **unknown**
 *
 * Deliberate: the `.com` is treated as the dominant signal. A taken
 * `.com` is almost always a red flag even if `.io` is free. `.co.uk`
 * is a nice-to-have, not a dominant signal — if it's taken we drop to
 * amber, not red.
 */
export function deriveBrandConfidence(candidate: NamingCandidate): BrandConfidence {
  const allChecks: AvailabilityCheck[] = [
    ...Object.values(candidate.domainStatus),
    ...Object.values(candidate.trademarkStatus),
    ...Object.values(candidate.socialStatus),
  ];

  if (allChecks.length === 0) return "unknown";
  if (allChecks.every((c) => c.status === "unknown")) return "unknown";

  // Red: .com claimed or any trademark hit.
  const comCheck = candidate.domainStatus[`${candidate.name.toLowerCase()}.com`];
  const comBad =
    comCheck && (comCheck.status === "taken" || comCheck.status === "parked");
  const trademarkHit = Object.values(candidate.trademarkStatus).some(
    (c) => c.status === "taken"
  );
  if (comBad || trademarkHit) return "red";

  // Amber: any error/restricted/taken on a non-.com resource.
  const hasUncertainty = allChecks.some(
    (c) =>
      c.status === "error" ||
      c.status === "restricted" ||
      c.status === "taken" ||
      c.status === "parked"
  );
  if (hasUncertainty) return "amber";

  // Green requires the core set (at least a .com check) to be positive.
  const hasComCheck = !!comCheck;
  const allGreen = allChecks.every(
    (c) => c.status === "available" || c.status === "unknown"
  );
  if (hasComCheck && allGreen) {
    // Require >= 2 positives to avoid promoting a single "available"
    // click to green. Keeps the confidence honest.
    const positives = allChecks.filter((c) => c.status === "available").length;
    return positives >= 2 ? "green" : "amber";
  }

  return "amber";
}

/**
 * Helpers for the UI when building empty candidates (AI fills the name
 * + rationale, everything else starts at unknown). Generated ids use
 * `crypto.randomUUID` when available with a fallback for older browsers.
 */
export function makeCandidateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `cand-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createEmptyCandidate(opts: {
  name: string;
  rationale?: string;
  style?: string;
}): NamingCandidate {
  const now = new Date().toISOString();
  return {
    id: makeCandidateId(),
    name: opts.name.trim(),
    rationale: opts.rationale?.trim() ?? "",
    style: opts.style,
    domainStatus: {},
    trademarkStatus: {},
    socialStatus: {},
    notes: "",
    updatedAt: now,
  };
}

/**
 * Build a fresh empty scan for a venture. Callers use this when the
 * on-disk file is missing — they populate candidates and persist.
 */
export function createEmptyNamingScan(ventureId: string): NamingScan {
  const now = new Date().toISOString();
  return {
    ventureId,
    candidates: [],
    chosenCandidateId: null,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}
