import {
  type BrandConfidence,
  type NamingCandidate,
  NamingScanSchema,
  deriveBrandConfidence,
} from "@founder-os/branding-core";
import type { FailedRunEntry, Venture, VentureManifest } from "@founder-os/domain";
import { optimize } from "@founder-os/prompt-master";
import { invoke } from "@tauri-apps/api/core";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
/**
 * Audit tab — renders audit findings per pipeline run.
 *
 * The Rust side persists findings into `audit_findings` at the end of each
 * pipeline run (see VentureDashboard → handleRunPipeline). This component
 * just reads them back, grouped by run and sorted by severity within each
 * run. Two-column layout: run list on the left, expanded findings on the
 * right.
 *
 * Refreshes automatically when `refreshToken` changes — the dashboard bumps
 * it after a pipeline run so the tab lights up with new findings without
 * the user having to click anything.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as db from "../../lib/db.js";
import { findLatestFailedRunForStage } from "../../lib/failed-runs.js";
import { pickActiveProvider, streamChat } from "../../lib/llm-client.js";
import { runAuditStage } from "../../lib/run-audit-stage.js";
import { runBuildStage } from "../../lib/run-build-stage.js";
import { runFinanceStage } from "../../lib/run-finance-stage.js";
import { runLaunchStage } from "../../lib/run-launch-stage.js";
import { pushToast } from "../../lib/toasts.js";
import { FailedRunBanner } from "./FailedRunBanner.js";
import { renderMarkdown } from "./markdown.js";

// Local error stringifier — matches db.ts / venture-io.ts. Kept inline
// rather than sharing so this file doesn't grow a new lib dep for a
// 6-line helper.
function errDetail(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

type Props = {
  /**
   * Full venture row -- needed by the AuditStageRunner / BuildStageRunner
   * adoption helpers which take a Venture (id + rootPath) plus a
   * VentureManifest. Optional so callers that only need history
   * rendering (no run buttons) can omit it; the run/retry CTAs
   * disable themselves when missing.
   */
  venture?: Venture;
  /** Same story: optional, gates the run buttons. */
  manifest?: VentureManifest | null;
  ventureId: string;
  /**
   * pt.30d: optional venture root path. When provided, the export
   * pipeline reads `03_brand/names/name-candidates.json` and derives
   * the chosen candidate's brand confidence (`green | amber | red |
   * unknown`) into the JSON export. Optional so tests / future
   * embeddings of AuditTab can render without a filesystem path.
   */
  ventureRoot?: string;
  /** Bump this number to force a refresh (e.g. after a pipeline run). */
  refreshToken?: number;
};

type Severity = "low" | "medium" | "high" | "critical";

const SEVERITY_META: Record<Severity, { label: string; bg: string; fg: string; border: string }> = {
  critical: {
    label: "Critical",
    bg: "var(--danger-soft)",
    fg: "var(--danger)",
    border: "var(--danger-border)",
  },
  high: {
    label: "High",
    bg: "var(--warning-soft)",
    fg: "var(--warning)",
    border: "var(--warning-soft)",
  },
  medium: {
    label: "Medium",
    bg: "var(--accent-soft)",
    fg: "var(--accent-hover)",
    border: "var(--accent)",
  },
  low: {
    label: "Low",
    bg: "var(--bg-hover)",
    fg: "var(--text-secondary)",
    border: "var(--border-input)",
  },
};

function severityRank(s: string): number {
  switch (s) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
    default:
      return 4;
  }
}

// ---------------------------------------------------------------------------
// Export serializers
//
// Two formats: JSON (lossless, good for automation / pasting into Claude) and
// CSV (spreadsheet-friendly, readable in chats/tickets). Two scopes: the
// currently-selected run, or every run on this venture.
//
// JSON also carries any persisted fix suggestions (from AI "Ask to fix")
// keyed by finding id. CSV intentionally doesn't — multi-line markdown in a
// spreadsheet cell is a usability disaster and CSV is the "import into a
// ticket/sheet" format. If someone wants suggestions + tabular, they can
// export JSON and transform it with jq.
// ---------------------------------------------------------------------------

/**
 * One run plus its findings and (optionally) the persisted fix suggestions
 * for those findings. The fix map may be empty — that's normal; the user
 * may not have asked for fixes on this run.
 */
type ExportRunBlock = {
  run: db.RunRow;
  findings: db.FindingRow[];
  fixSuggestions: Record<string, db.FixSuggestionRow>;
};

/**
 * pt.30d: brand confidence read from disk at export time. Optional —
 * undefined when no name-candidates.json exists, or no candidate has
 * been chosen, or the file fails to parse. Recomputed every export so
 * the value is always derived from the current on-disk status slots
 * (matches the BrandTab's "always derive, never persist" rule).
 *
 * pt.31c: extended with per-resource status counts so downstream tooling
 * can score across runs / ventures without re-reading
 * `name-candidates.json`. Counts group every check in `domainStatus` /
 * `socialStatus` / `trademarkStatus` by status; an unchecked candidate
 * has all-zero counts (or omitted entirely if the candidate has no
 * recorded slots).
 */
type ExportBrandCounts = {
  available: number;
  taken: number;
  parked: number;
  restricted: number;
  error: number;
  unknown: number;
};

type ExportBrand = {
  candidateId: string;
  candidateName: string;
  confidence: BrandConfidence;
  /** pt.31c: aggregate counts across the chosen candidate's check slots. */
  domains?: ExportBrandCounts;
  socials?: ExportBrandCounts;
  trademarks?: ExportBrandCounts;
};

/**
 * pt.31c: tally a status record (one of domainStatus / socialStatus /
 * trademarkStatus) into a counts object. Returns undefined when the
 * record is empty so the serializer can omit the key — exporting a
 * block of all-zeros for an unchecked candidate is just noise.
 */
function tallyStatusRecord(
  record: Record<string, { status: string }>
): ExportBrandCounts | undefined {
  const entries = Object.values(record);
  if (entries.length === 0) return undefined;
  const counts: ExportBrandCounts = {
    available: 0,
    taken: 0,
    parked: 0,
    restricted: 0,
    error: 0,
    unknown: 0,
  };
  for (const entry of entries) {
    switch (entry.status) {
      case "available":
        counts.available++;
        break;
      case "taken":
        counts.taken++;
        break;
      case "parked":
        counts.parked++;
        break;
      case "restricted":
        counts.restricted++;
        break;
      case "error":
        counts.error++;
        break;
      default:
        // "unknown" or any future enum value rolls into unknown so the
        // counts always sum to entries.length even if the schema grows.
        counts.unknown++;
    }
  }
  return counts;
}

/**
 * What we export. Discriminated union so serializers can branch on scope
 * without re-running the "is the selected run still valid" check. The
 * single-run shape is preserved for the common case — changing it would
 * break any downstream tooling (e.g. a Claude prompt Chris has saved that
 * expects the old flat keys). Adding `"scope"` as a field makes intent
 * machine-readable too.
 *
 * pt.30d: optional `brand` field carries the brand confidence summary
 * when the venture has a chosen naming candidate. Omitted entirely
 * (vs `null`) when not derivable, so existing JSON consumers see a
 * clean shape unchanged from pt.21.
 */
type ExportPayload =
  | { scope: "selected"; ventureId: string; block: ExportRunBlock; brand?: ExportBrand }
  | { scope: "all"; ventureId: string; blocks: ExportRunBlock[]; brand?: ExportBrand };

function serializeFixSuggestions(
  map: Record<string, db.FixSuggestionRow>
): Record<string, unknown> | undefined {
  // Omit the key entirely when empty so JSON consumers can distinguish
  // "no suggestions saved" from "suggestions block is present but empty".
  const keys = Object.keys(map);
  if (keys.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const id of keys) {
    const s = map[id];
    out[id] = {
      text: s.text,
      provider: s.provider,
      model: s.model ?? null,
      createdAt: s.createdAt,
    };
  }
  return out;
}

function runBlockToJson(block: ExportRunBlock): Record<string, unknown> {
  const fix = serializeFixSuggestions(block.fixSuggestions);
  return {
    runId: block.run.runId,
    runStatus: block.run.status,
    runCreatedAt: block.run.createdAt,
    runCompletedAt: block.run.completedAt ?? null,
    findingCount: block.findings.length,
    findings: block.findings.map((f) => ({
      id: f.id,
      ruleId: f.ruleId,
      severity: f.severity,
      title: f.title,
      message: f.message,
      filePath: f.filePath ?? null,
      createdAt: f.createdAt,
    })),
    // Only include the fix-suggestions object when at least one exists.
    // Consumers who want a total count can sum fix-suggestion-entry counts
    // themselves — we don't duplicate into a findingsWithFixCount field.
    ...(fix ? { fixSuggestions: fix } : {}),
  };
}

function buildExportJson(payload: ExportPayload): string {
  const exportedAt = new Date().toISOString();
  // pt.30d: brand block is identical for both scopes — emitted at
  // payload-level, not per-run, because it's a venture-wide signal
  // (the chosen candidate doesn't change between runs).
  const brand = payload.brand ? { brand: payload.brand } : {};
  if (payload.scope === "selected") {
    const b = payload.block;
    // Preserve the old flat shape for scope=selected. The only change vs.
    // pt.8's emission is the new `scope` discriminator + the optional
    // `fixSuggestions` key. Field order stays as it was so diffs against
    // earlier exports are clean.
    const fix = serializeFixSuggestions(b.fixSuggestions);
    return JSON.stringify(
      {
        ventureId: payload.ventureId,
        scope: "selected",
        runId: b.run.runId,
        runStatus: b.run.status,
        runCreatedAt: b.run.createdAt,
        runCompletedAt: b.run.completedAt ?? null,
        exportedAt,
        ...brand,
        findingCount: b.findings.length,
        findings: b.findings.map((f) => ({
          id: f.id,
          ruleId: f.ruleId,
          severity: f.severity,
          title: f.title,
          message: f.message,
          filePath: f.filePath ?? null,
          createdAt: f.createdAt,
        })),
        ...(fix ? { fixSuggestions: fix } : {}),
      },
      null,
      2
    );
  }
  // scope === "all"
  const findingCount = payload.blocks.reduce((acc, b) => acc + b.findings.length, 0);
  return JSON.stringify(
    {
      ventureId: payload.ventureId,
      scope: "all",
      exportedAt,
      ...brand,
      runCount: payload.blocks.length,
      findingCount,
      runs: payload.blocks.map(runBlockToJson),
    },
    null,
    2
  );
}

function csvEscape(value: string | null | undefined): string {
  // RFC 4180: a field needs quoting if it contains a comma, a double quote,
  // a CR, or an LF. Inside a quoted field, double any embedded double quotes.
  // Null/undefined → empty cell (not the string "null" — keeps CSV clean).
  if (value == null) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildExportCsv(payload: ExportPayload): string {
  const exportedAt = new Date().toISOString();
  if (payload.scope === "selected") {
    const { ventureId } = payload;
    const { run, findings } = payload.block;
    // Leading `#`-prefixed metadata lines so the file is self-describing when
    // opened days later, plus a blank line before the header row. Excel and
    // Google Sheets treat the metadata rows as ordinary cells — that's fine;
    // they land in column A and scan visually as a tiny header.
    const header = [
      "severity",
      "ruleId",
      "title",
      "message",
      "filePath",
      "createdAt",
      "findingId",
    ].join(",");
    const lines = [
      "# Founder OS audit export",
      "# scope,selected",
      `# ventureId,${csvEscape(ventureId)}`,
      `# runId,${csvEscape(run.runId)}`,
      `# runStatus,${csvEscape(run.status)}`,
      `# runCreatedAt,${csvEscape(run.createdAt)}`,
      `# exportedAt,${csvEscape(exportedAt)}`,
      `# findingCount,${findings.length}`,
      "",
      header,
    ];
    for (const f of findings) {
      lines.push(
        [
          csvEscape(f.severity),
          csvEscape(f.ruleId),
          csvEscape(f.title),
          csvEscape(f.message),
          csvEscape(f.filePath),
          csvEscape(f.createdAt),
          csvEscape(f.id),
        ].join(",")
      );
    }
    // CRLF line endings — matches the CSV spec and what Excel writes on Windows.
    return `${lines.join("\r\n")}\r\n`;
  }
  // scope === "all" — prepend runId/runCreatedAt columns so you can pivot
  // by run in a spreadsheet. Metadata block lists the per-run summary so
  // the file is still self-describing without needing the JSON twin.
  const { ventureId, blocks } = payload;
  const findingCount = blocks.reduce((acc, b) => acc + b.findings.length, 0);
  const header = [
    "runId",
    "runCreatedAt",
    "severity",
    "ruleId",
    "title",
    "message",
    "filePath",
    "findingCreatedAt",
    "findingId",
  ].join(",");
  const lines = [
    "# Founder OS audit export",
    "# scope,all",
    `# ventureId,${csvEscape(ventureId)}`,
    `# exportedAt,${csvEscape(exportedAt)}`,
    `# runCount,${blocks.length}`,
    `# findingCount,${findingCount}`,
    "",
    header,
  ];
  for (const b of blocks) {
    for (const f of b.findings) {
      lines.push(
        [
          csvEscape(b.run.runId),
          csvEscape(b.run.createdAt),
          csvEscape(f.severity),
          csvEscape(f.ruleId),
          csvEscape(f.title),
          csvEscape(f.message),
          csvEscape(f.filePath),
          csvEscape(f.createdAt),
          csvEscape(f.id),
        ].join(",")
      );
    }
  }
  return `${lines.join("\r\n")}\r\n`;
}

function defaultExportFilename(payload: ExportPayload, ext: "json" | "csv"): string {
  // Short run id + ISO date (no time, no colons — Windows-safe) keeps the
  // name readable and sortable in a folder. All-runs exports use a literal
  // "all-runs" tag instead of a short id so they don't collide with
  // single-run exports of the same date.
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (payload.scope === "selected") {
    const short = payload.block.run.runId.slice(0, 8);
    return `founder-os-audit-${short}-${date}.${ext}`;
  }
  return `founder-os-audit-all-runs-${date}.${ext}`;
}

type FixState = {
  // `stopping` is an optimistic, UI-only intermediate — set the instant the
  // user clicks Stop, before the Rust cancel + llm-cancel event round-trips
  // back. It's always followed by `cancelled` (normal path) or `done`/`error`
  // (races where the stream finished first). Keeps the Stop button from
  // feeling dead for the few hundred ms the cancel takes to land.
  status: "idle" | "loading" | "streaming" | "stopping" | "done" | "cancelled" | "error";
  text: string;
  error?: string;
};

const SYSTEM_PROMPT =
  "You are Founder OS's audit remediation assistant. The user runs an automated audit against generated venture artifacts (brand briefs, build handoffs, design tokens, etc). You are shown one finding at a time, along with the offending file's contents when available. Respond with a concise, concrete fix: (1) a 1-sentence diagnosis, (2) the exact change to make — show a full corrected snippet if the fix is a small edit, (3) a short rationale. Do not hedge. Do not recommend ignoring the finding. If the fix requires the user to make a product decision, state the decision and give your recommended default.";

export function AuditTab({ venture, manifest, ventureId, ventureRoot, refreshToken = 0 }: Props) {
  const [runs, setRuns] = useState<db.RunRow[]>([]);
  const [findingsByRun, setFindingsByRun] = useState<Record<string, db.FindingRow[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [fixState, setFixState] = useState<Record<string, FixState>>({});
  const [openErrors, setOpenErrors] = useState<Record<string, string>>({});
  const [runningAuditStage, setRunningAuditStage] = useState(false);
  const [runningBuildStage, setRunningBuildStage] = useState(false);
  const [failedAuditRun, setFailedAuditRun] = useState<FailedRunEntry | null>(null);
  const [failedBuildRun, setFailedBuildRun] = useState<FailedRunEntry | null>(null);
  // Stage-runner adoption: FINANCE + LAUNCH (skeletal). No dedicated
  // tab today; AuditTab hosts them in the existing "Stage runners:" row.
  const [runningFinanceStage, setRunningFinanceStage] = useState(false);
  const [runningLaunchStage, setRunningLaunchStage] = useState(false);
  const [failedFinanceRun, setFailedFinanceRun] = useState<FailedRunEntry | null>(null);
  const [failedLaunchRun, setFailedLaunchRun] = useState<FailedRunEntry | null>(null);
  // Export menu: open/close flag, plus a transient status line that shows
  // "Copied JSON", "Saved to …", or an error for ~2s after the action runs.
  // Anchor ref is used for outside-click detection on the dropdown.
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exportStatus, setExportStatus] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  // Export scope — "selected" = only the currently-selected run (pt.8
  // original), "all" = every run on this venture (pt.21 nice-to-have).
  // Defaults to "selected" so the common case still feels identical.
  // Remembered between openings of the menu within a session; resets on
  // unmount (venture switch). No need to persist across sessions — picking
  // a scope is a per-export decision.
  const [exportScope, setExportScope] = useState<"selected" | "all">("selected");
  // AbortController per in-flight fix stream, keyed on findingId. Ref (not
  // state) because mutating the map doesn't need to re-render — the Stop
  // button's visibility is driven by `fixState.status === 'streaming'`,
  // not by the controller's presence. Cleared on done/cancel/error/dismiss
  // so a stale controller can't accidentally cancel a fresh stream.
  const fixControllersRef = useRef<Record<string, AbortController>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Pull runs + all findings for this venture in parallel; we'll group
      // findings by runId client-side. One pass is cheaper than N per-run
      // queries and the volumes are small (< a few hundred rows).
      const [runRows, findingRows] = await Promise.all([
        db.listRunsForVenture(ventureId),
        db.listFindingsForVenture(ventureId),
      ]);
      const grouped: Record<string, db.FindingRow[]> = {};
      for (const f of findingRows) {
        // biome-ignore lint/suspicious/noAssignInExpressions: intentional assign-and-test pattern
        (grouped[f.runId] ||= []).push(f);
      }
      // Severity-order within each run (DB already orders but we re-sort
      // defensively in case of future query changes).
      for (const runId of Object.keys(grouped)) {
        grouped[runId].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
      }
      setRuns(runRows);
      setFindingsByRun(grouped);
      // Default-select the most recent run on first load or if current
      // selection is gone.
      if (runRows.length > 0) {
        setSelectedRunId((prev) =>
          prev && runRows.some((r) => r.runId === prev) ? prev : runRows[0].runId
        );
      } else {
        setSelectedRunId(null);
      }
    } catch (err) {
      console.error("[audit] refresh failed", err);
      const msg = errDetail(err);
      // Sticky error toast — the tab shows an inline error via setError
      // below, but the audit tab is often not the one the user is
      // looking at when a refresh runs in the background (it's bumped
      // after pipeline runs). Toast ensures they see it from any tab.
      pushToast({
        kind: "error",
        message: "Couldn't load audit findings",
        detail: msg,
      });
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [ventureId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps intentionally omitted
  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken]);

  const selectedFindings = useMemo(
    () => (selectedRunId ? (findingsByRun[selectedRunId] ?? []) : []),
    [selectedRunId, findingsByRun]
  );

  /**
   * pt.40c — Split synthetic meta-findings out of the main listing.
   *
   * Findings with `ruleId` starting with `audit.meta.` are informational
   * (e.g. "N rules deferred until later stages" from pt.36) — they don't
   * describe an actionable issue, so showing them as full finding cards
   * mixed in with real findings is noisy. They render as a chip-style
   * banner above the actionable list instead.
   *
   * The split is keyed off the prefix because the audit-venture step
   * deliberately namespaces meta-findings under `audit.meta.*` for
   * exactly this kind of UI partition. Real audit findings use
   * domain-prefixed IDs (`uk-setup.*`, `manifest.*`, `artifact.*`,
   * `tokens.*`, etc.) and are unaffected.
   */
  const selectedActionable = useMemo(
    () => selectedFindings.filter((f) => !f.ruleId.startsWith("audit.meta.")),
    [selectedFindings]
  );
  const selectedMeta = useMemo(
    () => selectedFindings.filter((f) => f.ruleId.startsWith("audit.meta.")),
    [selectedFindings]
  );

  // When the selected run changes, load any persisted fix suggestions for
  // its findings and seed fixState as 'done' entries. This is what makes
  // the drawer re-appear after app reload without burning fresh tokens.
  // Runs ignore in-flight streams (their findings are handled by askAiToFix
  // directly).
  useEffect(() => {
    if (!selectedRunId) return;
    let cancelled = false;
    (async () => {
      try {
        const map = await db.listFixSuggestionsForRun(selectedRunId);
        if (cancelled) return;
        setFixState((prev) => {
          const next = { ...prev };
          for (const [findingId, row] of Object.entries(map)) {
            // Don't clobber a stream that's currently in flight for this
            // finding — the DB copy is always older than a live stream.
            const cur = next[findingId];
            if (cur?.status === "loading" || cur?.status === "streaming") continue;
            next[findingId] = { status: "done", text: row.text };
          }
          return next;
        });
      } catch (err) {
        console.warn("[audit] listFixSuggestionsForRun failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  const askAiToFix = useCallback(
    async (finding: db.FindingRow) => {
      // If an older controller is lingering (shouldn't happen — askAiToFix
      // is gated by `isBusy` — but belt + braces), abort it first so its
      // event handlers don't fire into a fresh state.
      const existing = fixControllersRef.current[finding.id];
      if (existing) {
        existing.abort();
        delete fixControllersRef.current[finding.id];
      }
      const controller = new AbortController();
      fixControllersRef.current[finding.id] = controller;

      // Reset to loading — also clears any prior run so the user gets a fresh
      // stream rather than seeing stale text while the new one warms up.
      setFixState((prev) => ({
        ...prev,
        [finding.id]: { status: "loading", text: "" },
      }));

      try {
        const provider = await pickActiveProvider(ventureId);
        if (!provider) {
          throw new Error("No LLM provider configured. Open the Options tab to add an API key.");
        }

        // Best-effort file read — if it fails we still ask the model for a
        // fix, just without the file body as context. Large files get
        // truncated so we don't blow past the context window on tokens.json
        // or similar.
        let fileExcerpt = "";
        if (finding.filePath) {
          try {
            const content = await invoke<string>("read_file", {
              path: finding.filePath,
            });
            const MAX = 6000;
            fileExcerpt = content.length > MAX ? `${content.slice(0, MAX)}\n…[truncated]` : content;
          } catch (readErr) {
            console.warn("[audit] read_file failed", readErr);
            fileExcerpt = `(could not read file: ${String(readErr)})`;
            // Warn toast — the fix flow continues without the file body,
            // so the AI produces a less-grounded suggestion. Telling the
            // user lets them understand why the fix might be generic.
            // Dedupe collapses the common "same file keeps 404-ing"
            // case across repeated Ask/Ask-again clicks.
            pushToast({
              kind: "warn",
              message: "Couldn't read file for fix context",
              detail: `${finding.filePath}: ${errDetail(readErr)}`,
              ttlMs: 6000,
            });
          }
        }

        const userMessage = [
          `Audit finding — rule: ${finding.ruleId} (${finding.severity})`,
          `Title: ${finding.title}`,
          `Message: ${finding.message}`,
          finding.filePath ? `File: ${finding.filePath}` : "File: (not applicable)",
          fileExcerpt ? `\n--- current file contents ---\n${fileExcerpt}` : "",
          "\nGive me the fix.",
        ]
          .filter(Boolean)
          .join("\n");

        setFixState((prev) => ({
          ...prev,
          [finding.id]: { status: "streaming", text: "" },
        }));

        // Compress the audit-fix system prompt before dispatching. optimize()
        // never throws — fallbackUsed=true means no transport, in which case
        // we send the original text and the call still works.
        const optimizedSystem = await optimize({
          prompt: SYSTEM_PROMPT,
          context: "audit",
          ventureId,
        });
        console.info(
          "[prompt-master] audit-fix",
          optimizedSystem.fallbackUsed
            ? "(fallback — transport unavailable)"
            : `tokensSaved=${optimizedSystem.tokensSaved} cacheHit=${optimizedSystem.cacheHit}`
        );

        await streamChat({
          provider,
          system: optimizedSystem.optimized,
          messages: [{ role: "user", content: userMessage }],
          maxTokens: 1200,
          temperature: 0.2,
          signal: controller.signal,
          onDelta: (delta) => {
            setFixState((prev) => {
              const cur = prev[finding.id];
              if (!cur) return prev;
              return {
                ...prev,
                [finding.id]: { ...cur, text: cur.text + delta },
              };
            });
          },
          onDone: (text) => {
            setFixState((prev) => ({
              ...prev,
              [finding.id]: { status: "done", text },
            }));
            // Fire-and-forget persist so a second visit doesn't re-burn
            // tokens on the same diagnosis. If the write fails we log but
            // don't surface — the suggestion is already on screen.
            void db
              .upsertFixSuggestion({
                findingId: finding.id,
                text,
                provider,
              })
              .catch((err) => console.warn("[audit] upsertFixSuggestion failed", err));
          },
          onCancel: (partial) => {
            // User hit Stop. Keep the partial visible with a "Cancelled"
            // label so they can see what the model was about to say, but
            // DON'T persist — the text is half-baked and re-asking gives a
            // clean full response.
            setFixState((prev) => ({
              ...prev,
              [finding.id]: { status: "cancelled", text: partial },
            }));
          },
        });
      } catch (err) {
        // streamChat throws AbortError on cancel — those are handled by
        // onCancel above, so we only need to care about real errors here.
        // `name === "AbortError"` matches our custom class and any future
        // DOMException we might throw.
        if ((err as { name?: string })?.name === "AbortError") {
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        setFixState((prev) => ({
          ...prev,
          [finding.id]: {
            status: "error",
            text: prev[finding.id]?.text ?? "",
            error: msg,
          },
        }));
      } finally {
        // Always drop the controller — its stream is done (success / cancel
        // / error) and a stale reference would make the next Stop click
        // abort the wrong thing.
        if (fixControllersRef.current[finding.id] === controller) {
          delete fixControllersRef.current[finding.id];
        }
      }
    },
    [ventureId]
  );

  const cancelFix = useCallback((findingId: string) => {
    const controller = fixControllersRef.current[findingId];
    if (!controller) return;
    controller.abort();
    // Optimistically flip to 'stopping' so the button immediately shows
    // "Stopping…" / goes disabled. The Rust side will emit `llm-cancel`
    // within a few ms (between-chunk check) and `onCancel` in streamChat
    // transitions to `cancelled` with the authoritative partial text —
    // that naturally overrides this state. If the stream finished first,
    // `onDone` lands and transitions to `done`, also overriding. We guard
    // against overwriting terminal states (done/error/cancelled) in case
    // of a fast race; only flip if we're actively loading or streaming.
    setFixState((prev) => {
      const cur = prev[findingId];
      if (!cur) return prev;
      if (cur.status !== "loading" && cur.status !== "streaming") return prev;
      return { ...prev, [findingId]: { ...cur, status: "stopping" } };
    });
  }, []);

  const dismissFix = useCallback((findingId: string) => {
    // Dismiss = "I'm done with this suggestion" — clear the UI state AND
    // remove the persisted row so it doesn't re-seed on next visit. If
    // the user wants it back, "Ask AI to fix" regenerates fresh.
    setFixState((prev) => {
      const next = { ...prev };
      delete next[findingId];
      return next;
    });
    void db
      .deleteFixSuggestion(findingId)
      .catch((err) => console.warn("[audit] deleteFixSuggestion failed", err));
  }, []);

  const copyFix = useCallback((text: string) => {
    // navigator.clipboard is available in Tauri's WebView; fall back silently
    // if for some reason it's not.
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(text);
    }
  }, []);

  const openInEditor = useCallback(async (finding: db.FindingRow) => {
    if (!finding.filePath) return;
    // Clear any previous error on this finding — stale banners are worse
    // than no banner.
    setOpenErrors((prev) => {
      const next = { ...prev };
      delete next[finding.id];
      return next;
    });
    try {
      // Read the editor preference fresh on every click. The lookup is one
      // indexed SQLite SELECT — cheap enough that the gain (always reflects
      // a Settings change without remounting AuditTab) is worth it.
      // Null preference → Rust falls through to the auto-detect candidate
      // chain (existing behaviour).
      const preferredEditor = await db.getEditorCommand();
      await invoke("open_in_editor", {
        path: finding.filePath,
        preferredEditor: preferredEditor ?? undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setOpenErrors((prev) => ({ ...prev, [finding.id]: msg }));
    }
  }, []);

  // ---------------- Export: copy + save handlers ------------------------
  //
  // Both copy and save actions operate on the currently-selected run. If
  // nothing is selected or the run has no findings, the Export button is
  // disabled upstream so these should never be reached with empty inputs —
  // but we guard anyway because UI invariants drift.

  const flashExportStatus = useCallback((kind: "success" | "error", text: string) => {
    setExportStatus({ kind, text });
    // Short auto-clear; long enough to read, short enough to not linger
    // into the next interaction.
    window.setTimeout(() => {
      setExportStatus((cur) => (cur && cur.text === text && cur.kind === kind ? null : cur));
    }, 2500);
  }, []);

  /**
   * pt.30d: read `03_brand/names/name-candidates.json` and derive the
   * chosen candidate's brand confidence. Returns undefined when:
   *   - ventureRoot wasn't passed in (e.g. test embedding)
   *   - the file doesn't exist (no naming step has run)
   *   - the file fails to parse (corrupt / older schema)
   *   - no candidate has been chosen yet
   * Errors are swallowed because a missing/broken brand file shouldn't
   * fail the whole export; we just omit the optional `brand` key.
   */
  const resolveBrandForExport = useCallback(async (): Promise<ExportBrand | undefined> => {
    if (!ventureRoot) return undefined;
    // Posix-style join — the Rust side normalises separators per OS.
    // No path utilities available in the WebView, so we hand-build.
    const path = `${ventureRoot.replace(/[\\/]+$/, "")}/03_brand/names/name-candidates.json`;
    let exists: boolean;
    try {
      exists = await invoke<boolean>("path_exists", { path });
    } catch {
      return undefined;
    }
    if (!exists) return undefined;
    let raw: string;
    try {
      raw = await invoke<string>("read_file", { path });
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const result = NamingScanSchema.safeParse(parsed);
    if (!result.success) return undefined;
    const scan = result.data;
    if (!scan.chosenCandidateId) return undefined;
    const chosen: NamingCandidate | undefined = scan.candidates.find(
      (c) => c.id === scan.chosenCandidateId
    );
    if (!chosen) return undefined;
    // pt.31c: pre-compute counts so the serializer can include them
    // verbatim. tallyStatusRecord returns undefined for empty records
    // → those keys get omitted via the spread below.
    const domains = tallyStatusRecord(chosen.domainStatus);
    const socials = tallyStatusRecord(chosen.socialStatus);
    const trademarks = tallyStatusRecord(chosen.trademarkStatus);
    return {
      candidateId: chosen.id,
      candidateName: chosen.name,
      confidence: deriveBrandConfidence(chosen),
      ...(domains ? { domains } : {}),
      ...(socials ? { socials } : {}),
      ...(trademarks ? { trademarks } : {}),
    };
  }, [ventureRoot]);

  /**
   * Resolve the current selection into a concrete ExportPayload, fetching
   * fix suggestions from the DB in parallel for each included run. Returns
   * null if the scope can't produce anything meaningful (no selected run /
   * no runs with findings) — callers treat null as a silent no-op because
   * the button is disabled in those cases anyway.
   *
   * Fix suggestions are fetched lazily here (not on tab mount) because
   * most users will never click Export — eager loading would add a
   * per-run DB query to every AuditTab mount for nothing.
   *
   * pt.30d: brand confidence is resolved alongside the run/findings
   * fetch (parallelised via Promise.all) so the export emits a
   * consistent venture-wide signal at the same wall-clock time.
   */
  const buildExportPayload = useCallback(
    async (scope: "selected" | "all"): Promise<ExportPayload | null> => {
      if (scope === "selected") {
        if (!selectedRunId) return null;
        const run = runs.find((r) => r.runId === selectedRunId);
        if (!run) return null;
        const findings = findingsByRun[selectedRunId] ?? [];
        // pt.30d: brand fetch in parallel with the fix-suggestions
        // fetch — both are independent reads, latency is the wall-clock
        // max of the two.
        const [fixSuggestions, brand] = await Promise.all([
          db.listFixSuggestionsForRun(selectedRunId).catch((err) => {
            // Non-fatal — export findings without suggestions rather
            // than failing the whole action. Log for visibility; no
            // toast because the export still produces useful output.
            console.warn("[audit] listFixSuggestionsForRun failed (export)", err);
            return {} as Record<string, db.FixSuggestionRow>;
          }),
          resolveBrandForExport(),
        ]);
        return {
          scope: "selected",
          ventureId,
          block: { run, findings, fixSuggestions },
          brand,
        };
      }
      // scope === "all"
      // Only include runs that actually have findings — a run with zero
      // findings in the export would just be noise (rule-of-thumb: if it
      // doesn't appear on the Audit tab's list with a severity pill, it
      // shouldn't be in the export either).
      const runsWithFindings = runs.filter((r) => (findingsByRun[r.runId]?.length ?? 0) > 0);
      if (runsWithFindings.length === 0) return null;
      // Parallel fetch — each listFixSuggestionsForRun is a single JOIN.
      // N small parallel queries vs N serial round-trips is a latency win
      // on the common "export everything" click. pt.30d: brand fetch
      // joins the same wave so the wall-clock cost stays flat.
      const [blocks, brand] = await Promise.all([
        Promise.all(
          runsWithFindings.map(async (run) => {
            let fixSuggestions: Record<string, db.FixSuggestionRow> = {};
            try {
              fixSuggestions = await db.listFixSuggestionsForRun(run.runId);
            } catch (err) {
              console.warn("[audit] listFixSuggestionsForRun failed (export)", err);
            }
            return {
              run,
              findings: findingsByRun[run.runId] ?? [],
              fixSuggestions,
            };
          })
        ),
        resolveBrandForExport(),
      ]);
      return { scope: "all", ventureId, blocks, brand };
    },
    [selectedRunId, runs, findingsByRun, ventureId, resolveBrandForExport]
  );

  /**
   * Quick header for status toasts — "N finding · M run" / "N findings",
   * tuned for both scopes. Kept inline to the two handlers below; not
   * exported because the phrasing is UI-copy, not reusable domain logic.
   */
  const describePayload = (payload: ExportPayload): string => {
    if (payload.scope === "selected") {
      const n = payload.block.findings.length;
      return `${n} finding${n === 1 ? "" : "s"}`;
    }
    const runs = payload.blocks.length;
    const findings = payload.blocks.reduce((acc, b) => acc + b.findings.length, 0);
    return `${findings} finding${findings === 1 ? "" : "s"} across ${runs} run${runs === 1 ? "" : "s"}`;
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps intentionally omitted
  const copyExport = useCallback(
    async (format: "json" | "csv") => {
      const payload = await buildExportPayload(exportScope);
      if (!payload) return;
      try {
        const text = format === "json" ? buildExportJson(payload) : buildExportCsv(payload);
        // navigator.clipboard works in Tauri's WebView; writeText throws on
        // denial or non-secure contexts (shouldn't happen in tauri:// but we
        // still surface errors rather than failing silently).
        if (!navigator?.clipboard?.writeText) {
          throw new Error("Clipboard API unavailable");
        }
        await navigator.clipboard.writeText(text);
        flashExportStatus(
          "success",
          `Copied ${format.toUpperCase()} · ${describePayload(payload)}`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        flashExportStatus("error", `Copy failed: ${msg}`);
      } finally {
        setExportMenuOpen(false);
      }
    },
    [buildExportPayload, exportScope, flashExportStatus]
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps intentionally omitted
  const saveExport = useCallback(
    async (format: "json" | "csv") => {
      const payload = await buildExportPayload(exportScope);
      if (!payload) return;
      try {
        const text = format === "json" ? buildExportJson(payload) : buildExportCsv(payload);
        const defaultPath = defaultExportFilename(payload, format);
        // Native Save dialog — OS-level, respects the last-used directory.
        // Returns null if the user cancels; that's not an error, just a
        // silent no-op.
        const filePath = await saveFileDialog({
          defaultPath,
          filters: [
            {
              name: format === "json" ? "JSON" : "CSV",
              extensions: [format],
            },
          ],
        });
        if (!filePath) {
          setExportMenuOpen(false);
          return;
        }
        // Reuse our existing Rust write_file command (same one used for
        // other disk writes) so the path handling + error shape is
        // consistent across the app. tauri-plugin-fs would work too but
        // requires scope config that write_file sidesteps.
        await invoke("write_file", { path: filePath, content: text });
        flashExportStatus("success", `Saved ${format.toUpperCase()} · ${describePayload(payload)}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        flashExportStatus("error", `Save failed: ${msg}`);
      } finally {
        setExportMenuOpen(false);
      }
    },
    [buildExportPayload, exportScope, flashExportStatus]
  );

  // Close the export menu on outside click. mousedown so the menu closes
  // before any other click handler fires — avoids the "click selects a
  // finding AND closes the menu at the same time" double-action feel.
  useEffect(() => {
    if (!exportMenuOpen) return;
    const handler = (e: MouseEvent) => {
      const node = exportMenuRef.current;
      if (node && e.target instanceof Node && !node.contains(e.target)) {
        setExportMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [exportMenuOpen]);

  // Derived counts for the export button + scope toggle. Done here (not in
  // a useMemo) because the values are O(runs) to compute and runs are small
  // enough (< 100 in practice) that memoisation is overkill. React calls
  // this every render anyway.
  const selectedRunFindingCount = selectedRunId ? (findingsByRun[selectedRunId]?.length ?? 0) : 0;
  const allRunsFindingCount = Object.values(findingsByRun).reduce(
    (acc, arr) => acc + arr.length,
    0
  );
  const runsWithFindingsCount = runs.reduce(
    (acc, r) => acc + ((findingsByRun[r.runId]?.length ?? 0) > 0 ? 1 : 0),
    0
  );
  // Scope-aware enable check — what the Export button is gated on. When
  // the current scope has nothing to export, the button is disabled but
  // the user can still flip scopes by clicking the toggle inside the
  // dropdown (if we let them reach it). Keeping the button disabled on
  // an empty scope preserves the pt.8 invariant that Export never pops a
  // menu over zero findings.
  const canExportCurrentScope =
    exportScope === "selected" ? selectedRunFindingCount > 0 : runsWithFindingsCount > 0;
  // Title text for the button, mirrors the enable logic so users get a
  // reason when they hover a disabled button.
  const exportButtonTitle = canExportCurrentScope
    ? exportScope === "selected"
      ? `Export ${selectedRunFindingCount} finding${selectedRunFindingCount === 1 ? "" : "s"} for the selected run`
      : `Export ${allRunsFindingCount} findings across ${runsWithFindingsCount} run${runsWithFindingsCount === 1 ? "" : "s"}`
    : exportScope === "selected"
      ? selectedRunId
        ? "No findings in this run to export"
        : "Select a run to export its findings"
      : "No runs on this venture have findings to export";

  // Keyboard shortcut while the tab is mounted: Ctrl+E (or Cmd+E on
  // macOS) toggles the export menu. The effect unregisters on unmount
  // (tab switch) so the shortcut doesn't leak into the Overview / Chat /
  // etc. tabs.
  //
  // We use a ref + empty-deps so there's only ever one handler bound,
  // reading fresh state. Initially used [exportMenuOpen, canExportCurrentScope]
  // as deps, but that creates a race where a fast keypress can land BEFORE
  // the effect's cleanup + re-register, hitting the previous closure with
  // stale state. Empty deps + ref dodges it cleanly.
  //
  // Capture phase + window-level so the handler fires BEFORE element-level
  // or document-level listeners. Without `capture: true`, focused button
  // elements can intercept some keys.
  //
  // **Why no Escape close**: tested in pt.21 — WebView2 on Windows
  // intercepts the Escape key for its own popup/blur handling, so neither
  // bubble-phase nor capture-phase listeners on document or window ever
  // see the event. Verified with both empty-deps refs and capture-phase
  // window listeners. Outside-click (mousedown effect below) and Ctrl+E
  // toggle (this effect) cover the close affordances. If we ever need
  // Escape, register it Tauri-side via the globalShortcut plugin, but
  // that's overkill for a custom dropdown.
  const exportMenuOpenRef = useRef(exportMenuOpen);
  exportMenuOpenRef.current = exportMenuOpen;
  const canExportRef = useRef(canExportCurrentScope);
  canExportRef.current = canExportCurrentScope;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Skip if the user is typing in a form control — Ctrl+E has meaning
      // in some editors (e.g. "go to end of line" in Emacs-mode inputs on
      // macOS) so we don't want to fight with that.
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
          return;
        }
      }
      // Ctrl+E / Cmd+E toggle. Match case-insensitively because shift
      // state can flip `e`/`E`. Closing an already-open menu is always
      // allowed (scope doesn't matter there). Opening requires the
      // current scope to have something to export — otherwise we'd be
      // popping an empty/disabled menu, which is noise.
      const wantsToggle =
        (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "e" || e.key === "E");
      if (!wantsToggle) return;
      if (exportMenuOpenRef.current) {
        e.preventDefault();
        setExportMenuOpen(false);
        return;
      }
      if (!canExportRef.current) return;
      e.preventDefault();
      setExportMenuOpen(true);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  const handleRunAuditStage = async () => {
    if (runningAuditStage) return;
    if (!venture || !manifest) {
      pushToast({
        kind: "warn",
        message: "Venture context not ready",
        detail: "Manifest hasn't loaded yet -- try again in a moment.",
        ttlMs: 5000,
      });
      return;
    }
    setRunningAuditStage(true);
    pushToast({
      kind: "info",
      message: "Running audit stage...",
      detail: "Persists summary to 07_build/audits/.",
      ttlMs: 4000,
    });
    try {
      const out = await runAuditStage({
        venture,
        manifest,
        ventureStage: venture.stage,
      });
      const { result } = out;
      if (result.success) {
        pushToast({
          kind: "success",
          message: "Audit stage complete",
          detail: "Summary saved under 07_build/audits/.",
          ttlMs: 6000,
        });
      } else {
        pushToast({
          kind: result.error?.recoverable ? "warn" : "error",
          message: "Audit stage finished with blockers",
          detail: result.error?.message ?? "See findings table for details.",
        });
      }
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Couldn't run audit stage",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRunningAuditStage(false);
    }
  };

  const handleRunBuildStage = async () => {
    if (runningBuildStage) return;
    if (!venture || !manifest) {
      pushToast({
        kind: "warn",
        message: "Venture context not ready",
        detail: "Manifest hasn't loaded yet -- try again in a moment.",
        ttlMs: 5000,
      });
      return;
    }
    setRunningBuildStage(true);
    pushToast({
      kind: "info",
      message: "Dropping build handoff...",
      detail: "Bundle goes to .founder/handoffs/inbox/. The VS Code extension picks it up async.",
      ttlMs: 4500,
    });
    try {
      const out = await runBuildStage({ venture, manifest });
      const { result } = out;
      if (result.success) {
        pushToast({
          kind: "success",
          message: "Build handoff dropped",
          detail: "VS Code extension will process the bundle. Watch the Pipeline tab for progress.",
          ttlMs: 7000,
        });
      } else {
        pushToast({
          kind: "error",
          message: "Build handoff failed",
          detail: result.error?.message ?? "Unknown error",
        });
      }
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Couldn't drop build handoff",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRunningBuildStage(false);
    }
  };

  const handleRunFinanceStage = async () => {
    if (runningFinanceStage) return;
    if (!venture || !manifest) {
      pushToast({
        kind: "warn",
        message: "Venture context not ready",
        detail: "Manifest hasn't loaded yet -- try again in a moment.",
        ttlMs: 5000,
      });
      return;
    }
    setRunningFinanceStage(true);
    try {
      const out = await runFinanceStage({ venture, manifest });
      if (out.kind === "no-provider") {
        pushToast({
          kind: "warn",
          message: "No LLM provider configured",
          detail:
            "Configure a provider in Settings to get an LLM-written strategic narrative for the finance plan. The deterministic narrative is still written -- you can also wire a provider and re-run.",
          ttlMs: 7000,
        });
        return;
      }
      const { result, steps, canvasStatus, generationSource } = out;
      if (result.success) {
        const sourceSuffix =
          generationSource === "llm"
            ? " (LLM)"
            : generationSource === "deterministic-fallback"
              ? " (deterministic fallback)"
              : "";
        const canvasSuffix =
          canvasStatus === "preserved" ? " - canvas preserved" : "";
        pushToast({
          kind: "success",
          message: `Finance stage complete${steps.finance === "ok" ? sourceSuffix : " (no work to do)"}${canvasSuffix}`,
          detail: "Saved under 05_finance/.",
          ttlMs: 6000,
        });
      } else {
        pushToast({
          kind: "error",
          message: "Finance stage failed",
          detail: result.error?.message ?? "Unknown error",
        });
      }
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Couldn't run finance stage",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRunningFinanceStage(false);
    }
  };

  const handleRunLaunchStage = async () => {
    if (runningLaunchStage) return;
    if (!venture || !manifest) {
      pushToast({
        kind: "warn",
        message: "Venture context not ready",
        detail: "Manifest hasn't loaded yet -- try again in a moment.",
        ttlMs: 5000,
      });
      return;
    }
    setRunningLaunchStage(true);
    try {
      const out = await runLaunchStage({ venture, manifest });
      if (out.kind === "no-provider") {
        pushToast({
          kind: "warn",
          message: "No LLM provider configured",
          detail:
            "Configure a provider in Settings to get an LLM-written launch announcement. The deterministic announcement is still written -- you can also wire a provider and re-run.",
          ttlMs: 7000,
        });
        return;
      }
      const { result, steps, receiptStatus, generationSource } = out;
      if (result.success) {
        const sourceSuffix =
          generationSource === "llm"
            ? " (LLM)"
            : generationSource === "deterministic-fallback"
              ? " (deterministic fallback)"
              : "";
        const statusSuffix =
          receiptStatus === "ready-to-launch"
            ? " - READY"
            : receiptStatus === "needs-attention"
              ? " - needs attention"
              : "";
        pushToast({
          kind:
            receiptStatus === "needs-attention" ? "warn" : "success",
          message: `Launch stage complete${steps.launch === "ok" ? sourceSuffix : " (no work to do)"}${statusSuffix}`,
          detail: "Saved under 08_launch/. Open launch-announcement.md for the founder-facing copy.",
          ttlMs: 7000,
        });
      } else {
        pushToast({
          kind: "error",
          message: "Launch stage failed",
          detail: result.error?.message ?? "Unknown error",
        });
      }
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Couldn't run launch stage",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRunningLaunchStage(false);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps intentionally omitted
  useEffect(() => {
    if (!ventureRoot) return;
    let cancelled = false;
    findLatestFailedRunForStage(ventureRoot, "AUDIT")
      .then((entry) => {
        if (!cancelled) setFailedAuditRun(entry);
      })
      .catch(() => {
        if (!cancelled) setFailedAuditRun(null);
      });
    findLatestFailedRunForStage(ventureRoot, "BUILD")
      .then((entry) => {
        if (!cancelled) setFailedBuildRun(entry);
      })
      .catch(() => {
        if (!cancelled) setFailedBuildRun(null);
      });
    findLatestFailedRunForStage(ventureRoot, "FINANCE")
      .then((entry) => {
        if (!cancelled) setFailedFinanceRun(entry);
      })
      .catch(() => {
        if (!cancelled) setFailedFinanceRun(null);
      });
    findLatestFailedRunForStage(ventureRoot, "LAUNCH")
      .then((entry) => {
        if (!cancelled) setFailedLaunchRun(entry);
      })
      .catch(() => {
        if (!cancelled) setFailedLaunchRun(null);
      });
    return () => {
      cancelled = true;
    };
  }, [ventureRoot, runningAuditStage, runningBuildStage, runningFinanceStage, runningLaunchStage]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {ventureRoot && failedAuditRun && (
        <div style={{ padding: "0 28px" }}>
          <FailedRunBanner
            label="audit"
            entry={failedAuditRun}
            ventureRoot={ventureRoot}
            busy={runningAuditStage}
            disabled={!venture || !manifest}
            onRetry={handleRunAuditStage}
          />
        </div>
      )}
      {ventureRoot && failedBuildRun && (
        <div style={{ padding: "0 28px" }}>
          <FailedRunBanner
            label="build"
            entry={failedBuildRun}
            ventureRoot={ventureRoot}
            busy={runningBuildStage}
            disabled={!venture || !manifest}
            onRetry={handleRunBuildStage}
          />
        </div>
      )}
      {ventureRoot && failedFinanceRun && (
        <div style={{ padding: "0 28px" }}>
          <FailedRunBanner
            label="finance"
            entry={failedFinanceRun}
            ventureRoot={ventureRoot}
            busy={runningFinanceStage}
            disabled={!venture || !manifest}
            onRetry={handleRunFinanceStage}
          />
        </div>
      )}
      {ventureRoot && failedLaunchRun && (
        <div style={{ padding: "0 28px" }}>
          <FailedRunBanner
            label="launch"
            entry={failedLaunchRun}
            ventureRoot={ventureRoot}
            busy={runningLaunchStage}
            disabled={!venture || !manifest}
            onRetry={handleRunLaunchStage}
          />
        </div>
      )}
      <div
        style={{
          padding: "10px 28px",
          borderBottom: "1px solid var(--bg-hover)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)" }}>
          Stage runners:
        </span>
        <button
          type="button"
          onClick={handleRunAuditStage}
          disabled={runningAuditStage || !venture || !manifest}
          style={runnerBtnStyle(runningAuditStage, !venture || !manifest)}
        >
          {runningAuditStage ? "Running audit..." : "Run audit stage"}
        </button>
        <button
          type="button"
          onClick={handleRunBuildStage}
          disabled={runningBuildStage || !venture || !manifest}
          title="Drop a build handoff bundle. VS Code extension picks it up async."
          style={runnerBtnStyle(runningBuildStage, !venture || !manifest)}
        >
          {runningBuildStage ? "Dropping..." : "Drop build handoff"}
        </button>
        <button
          type="button"
          onClick={handleRunFinanceStage}
          disabled={runningFinanceStage || !venture || !manifest}
          title="Run finance stage via FinanceStageRunner (skeletal: ensures finance-canvas.json)"
          style={runnerBtnStyle(runningFinanceStage, !venture || !manifest)}
        >
          {runningFinanceStage ? "Running..." : "Run finance stage"}
        </button>
        <button
          type="button"
          onClick={handleRunLaunchStage}
          disabled={runningLaunchStage || !venture || !manifest}
          title="Run launch stage via LaunchStageRunner (skeletal: writes launch-receipt.json)"
          style={runnerBtnStyle(runningLaunchStage, !venture || !manifest)}
        >
          {runningLaunchStage ? "Running..." : "Run launch stage"}
        </button>
      </div>
      <div
        style={{
          padding: "12px 28px",
          borderBottom: "1px solid var(--bg-hover)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 12,
          color: "var(--text-tertiary)",
          gap: 12,
        }}
      >
        <span>
          {loading
            ? "Loading audit history…"
            : `${runs.length} run${runs.length === 1 ? "" : "s"} · ${Object.values(findingsByRun).flat().length} finding(s) total`}
        </span>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            marginLeft: "auto",
          }}
        >
          {exportStatus && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: exportStatus.kind === "success" ? "var(--success)" : "var(--danger)",
                // biome-ignore lint/a11y/useSemanticElements: role chosen intentionally; refactor deferred
              }}
              role="status"
            >
              {exportStatus.text}
            </span>
          )}
          {/* Export dropdown. Disabled when the current scope has nothing
              to export. Scope toggle lives inside the menu so flipping to
              "All" isn't gated on the Selected-scope enable check — but
              the button itself is gated on the *current* scope, so a user
              who's already on a scope with zero findings sees a disabled
              button and a title explaining why. Menu is absolutely
              positioned under the button; outside-click + Escape + Ctrl+E
              handlers all close via the effects above. */}
          <div ref={exportMenuRef} style={{ position: "relative", display: "inline-block" }}>
            <button
              type="button"
              onClick={() => setExportMenuOpen((v) => !v)}
              disabled={!canExportCurrentScope}
              title={`${exportButtonTitle}\n(Ctrl+E to toggle)`}
              style={{
                background: "none",
                border: "1px solid var(--border-input)",
                color: canExportCurrentScope ? "var(--text-secondary)" : "var(--text-muted)",
                fontSize: 12,
                fontWeight: 600,
                padding: "4px 10px",
                borderRadius: 4,
                cursor: canExportCurrentScope ? "pointer" : "not-allowed",
              }}
            >
              Export ▾
            </button>
            {exportMenuOpen && (
              <div
                role="menu"
                style={{
                  position: "absolute",
                  right: 0,
                  top: "calc(100% + 4px)",
                  minWidth: 220,
                  background: "var(--bg-panel)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 6,
                  boxShadow: "0 4px 12px rgba(0, 0, 0, 0.08)",
                  zIndex: 10,
                  padding: 4,
                }}
              >
                {/* Scope toggle — pill pair at the top so users can flip
                    between "just this run" and "every run" without leaving
                    the menu. We keep the selection between menu openings
                    (exportScope is component state) — opening again after
                    a successful All export keeps you on All. */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "4px 6px",
                    fontSize: 11,
                    color: "var(--text-tertiary)",
                  }}
                >
                  <span style={{ fontWeight: 600, marginRight: 4 }}>Scope:</span>
                  {(
                    [
                      {
                        key: "selected",
                        label: `Selected (${selectedRunFindingCount})`,
                        disabled: !selectedRunId,
                        title: selectedRunId
                          ? `Selected run only — ${selectedRunFindingCount} finding${selectedRunFindingCount === 1 ? "" : "s"}`
                          : "No run selected",
                      },
                      {
                        key: "all",
                        label: `All runs (${allRunsFindingCount})`,
                        disabled: runsWithFindingsCount === 0,
                        title:
                          runsWithFindingsCount > 0
                            ? `Every run on this venture — ${allRunsFindingCount} findings across ${runsWithFindingsCount} run${runsWithFindingsCount === 1 ? "" : "s"}`
                            : "No runs have findings",
                      },
                    ] as const
                  ).map((opt) => {
                    const active = exportScope === opt.key;
                    return (
                      <button
                        key={opt.key}
                        type="button"
                        onClick={() => setExportScope(opt.key)}
                        disabled={opt.disabled}
                        title={opt.title}
                        style={{
                          background: active ? "var(--accent-soft)" : "transparent",
                          border: active ? "1px solid var(--accent-soft)" : "1px solid transparent",
                          color: opt.disabled
                            ? "var(--text-muted)"
                            : active
                              ? "var(--accent-hover)"
                              : "var(--text-secondary)",
                          fontSize: 11,
                          fontWeight: active ? 600 : 500,
                          padding: "3px 8px",
                          borderRadius: 10,
                          cursor: opt.disabled ? "not-allowed" : "pointer",
                        }}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
                {/* Scope divider before the action list. */}
                <div
                  style={{
                    height: 1,
                    background: "var(--bg-hover)",
                    margin: "4px 0",
                  }}
                />
                {(
                  [
                    {
                      key: "copy-json",
                      label: "Copy as JSON",
                      run: () => void copyExport("json"),
                    },
                    {
                      key: "copy-csv",
                      label: "Copy as CSV",
                      run: () => void copyExport("csv"),
                    },
                    {
                      key: "save-json",
                      label: "Save as JSON…",
                      run: () => void saveExport("json"),
                    },
                    {
                      key: "save-csv",
                      label: "Save as CSV…",
                      run: () => void saveExport("csv"),
                    },
                  ] as const
                ).map((item, idx) => {
                  // Disable all action items if the current scope has
                  // nothing to export. Belt-and-braces — the outer button
                  // is already disabled in this case so the user normally
                  // can't open the menu, but a keyboard-focused flow
                  // (Ctrl+E after flipping scope) could in theory reach
                  // here with an empty scope.
                  const disabled = !canExportCurrentScope;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      role="menuitem"
                      onClick={disabled ? undefined : item.run}
                      disabled={disabled}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        background: "none",
                        border: "none",
                        color: disabled ? "var(--text-muted)" : "var(--text-primary)",
                        fontSize: 12,
                        fontWeight: 500,
                        padding: "6px 10px",
                        borderRadius: 4,
                        cursor: disabled ? "not-allowed" : "pointer",
                        // Subtle divider between "Copy" and "Save" groups.
                        borderTop: idx === 2 ? "1px solid var(--bg-hover)" : "none",
                        marginTop: idx === 2 ? 4 : 0,
                        paddingTop: idx === 2 ? 10 : 6,
                      }}
                      onMouseEnter={(e) => {
                        if (!disabled) e.currentTarget.style.background = "var(--accent-soft)";
                      }}
                      // biome-ignore lint/suspicious/noAssignInExpressions: intentional assign-and-test pattern
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            style={{
              background: "none",
              border: "none",
              color: "var(--accent)",
              fontSize: 12,
              cursor: loading ? "not-allowed" : "pointer",
              fontWeight: 600,
            }}
          >
            {loading ? "…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            margin: "12px 28px 0",
            padding: "8px 12px",
            background: "var(--danger-soft)",
            color: "var(--danger)",
            border: "1px solid var(--danger-border)",
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* Run list */}
        <div
          style={{
            width: 280,
            borderRight: "1px solid var(--bg-hover)",
            overflow: "auto",
          }}
        >
          {runs.length === 0 && !loading && (
            <div
              style={{
                padding: 24,
                fontSize: 13,
                color: "var(--text-muted)",
                textAlign: "center",
              }}
            >
              No pipeline runs yet. Click “Run Pipeline” on the Overview tab to generate audit
              findings.
            </div>
          )}
          {runs.map((run) => {
            // pt.40c — exclude meta-findings (audit.meta.*) from per-run
            // severity counts so the "1 low" badge reflects real
            // actionable issues, not the synthetic deferred-rules hint.
            // Same prefix split as in `selectedActionable` / `selectedMeta`.
            const ct = (findingsByRun[run.runId] ?? []).filter(
              (f) => !f.ruleId.startsWith("audit.meta.")
            );
            const isSelected = run.runId === selectedRunId;
            const counts = ct.reduce(
              (acc, f) => {
                acc[f.severity] = (acc[f.severity] ?? 0) + 1;
                return acc;
              },
              {} as Record<string, number>
            );
            return (
              <button
                key={run.runId}
                type="button"
                onClick={() => setSelectedRunId(run.runId)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "10px 16px",
                  border: "none",
                  borderLeft: isSelected ? "3px solid var(--accent)" : "3px solid transparent",
                  background: isSelected ? "var(--accent-soft)" : "transparent",
                  cursor: "pointer",
                  borderBottom: "1px solid var(--bg-elevated)",
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    fontFamily: "ui-monospace, monospace",
                    color: "var(--text-primary)",
                    fontWeight: 600,
                  }}
                >
                  {run.runId.slice(0, 8)}
                </div>
                <div
                  style={{
                    marginTop: 2,
                    fontSize: 11,
                    color: "var(--text-tertiary)",
                    display: "flex",
                    justifyContent: "space-between",
                  }}
                >
                  <span>{new Date(run.createdAt).toLocaleString()}</span>
                  <span
                    style={{
                      // pt.30b: "cancelled" gets neutral chrome (slate)
                      // rather than failure red — cancellation is a
                      // benign user action, not a fault.
                      color:
                        run.status === "succeeded"
                          ? "var(--success)"
                          : run.status === "failed"
                            ? "var(--danger)"
                            : run.status === "cancelled"
                              ? "var(--text-tertiary)"
                              : "var(--text-tertiary)",
                      fontWeight: 600,
                    }}
                  >
                    {run.status}
                  </span>
                </div>
                {ct.length > 0 && (
                  <div
                    style={{
                      marginTop: 6,
                      display: "flex",
                      gap: 4,
                      flexWrap: "wrap",
                    }}
                  >
                    {(["critical", "high", "medium", "low"] as Severity[]).map((sev) =>
                      counts[sev] ? (
                        <span
                          key={sev}
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            padding: "1px 6px",
                            borderRadius: 4,
                            background: SEVERITY_META[sev].bg,
                            color: SEVERITY_META[sev].fg,
                            border: `1px solid ${SEVERITY_META[sev].border}`,
                          }}
                        >
                          {counts[sev]} {SEVERITY_META[sev].label.toLowerCase()}
                        </span>
                      ) : null
                    )}
                  </div>
                )}
                {ct.length === 0 && run.status === "succeeded" && (
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 11,
                      color: "var(--success)",
                      fontWeight: 600,
                    }}
                  >
                    ✓ clean
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Findings pane */}
        <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
          {!selectedRunId && (
            <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
              Select a run to see its audit findings.
            </div>
          )}
          {selectedRunId && selectedActionable.length === 0 && selectedMeta.length === 0 && (
            <div
              style={{
                padding: 24,
                background: "var(--success-soft)",
                border: "1px solid var(--success-soft)",
                borderRadius: 8,
                color: "var(--success)",
                fontSize: 14,
              }}
            >
              <strong>No findings for this run.</strong>
              <div style={{ marginTop: 4, fontSize: 13 }}>
                Either the audit step passed cleanly or this run predates the audit step being wired
                in. Re-run the pipeline to (re)generate findings.
              </div>
            </div>
          )}
          {/* pt.40c — Meta-findings banner. Rendered above the actionable
              list, styled as informational (slate, not severity-coloured)
              so it reads as context rather than a problem. Each meta
              finding gets its own pill since there's typically only 0-1
              of them per run, so flexbox handles spacing naturally. */}
          {selectedMeta.length > 0 && (
            <div
              style={{
                marginBottom: 12,
                padding: "10px 14px",
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 8,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              {selectedMeta.map((f) => (
                <div
                  key={f.id}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 8,
                    fontSize: 12,
                    color: "var(--text-secondary)",
                  }}
                >
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      padding: "2px 6px",
                      borderRadius: 4,
                      background: "var(--border-subtle)",
                      color: "var(--text-secondary)",
                      textTransform: "uppercase",
                      letterSpacing: 0.4,
                      whiteSpace: "nowrap",
                    }}
                  >
                    info
                  </span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, color: "var(--text-secondary)" }}>{f.title}</div>
                    <div style={{ marginTop: 2, lineHeight: 1.4 }}>{f.message}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {selectedActionable.map((f) => {
            const meta = SEVERITY_META[f.severity] ?? SEVERITY_META.low;
            const fix = fixState[f.id];
            const isBusy =
              fix?.status === "loading" ||
              fix?.status === "streaming" ||
              fix?.status === "stopping";
            const isStopping = fix?.status === "stopping";
            return (
              <div
                key={f.id}
                style={{
                  padding: 14,
                  marginBottom: 10,
                  borderRadius: 8,
                  border: `1px solid ${meta.border}`,
                  background: "var(--bg-panel)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    marginBottom: 6,
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      padding: "2px 8px",
                      borderRadius: 4,
                      background: meta.bg,
                      color: meta.fg,
                      textTransform: "uppercase",
                      letterSpacing: 0.4,
                    }}
                  >
                    {meta.label}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      fontFamily: "ui-monospace, monospace",
                      color: "var(--text-muted)",
                    }}
                  >
                    {f.ruleId}
                  </span>
                  <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                    {f.filePath && (
                      <button
                        type="button"
                        onClick={() => void openInEditor(f)}
                        title={`Open ${f.filePath} in your code editor`}
                        style={{
                          background: "var(--bg-panel)",
                          border: "1px solid var(--border-input)",
                          color: "var(--text-secondary)",
                          fontSize: 11,
                          fontWeight: 600,
                          padding: "4px 10px",
                          borderRadius: 4,
                          cursor: "pointer",
                        }}
                      >
                        Open in editor
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void askAiToFix(f)}
                      disabled={isBusy}
                      style={{
                        background: isBusy ? "var(--border-subtle)" : "var(--accent)",
                        border: "none",
                        color: isBusy ? "var(--text-tertiary)" : "var(--bg-panel)",
                        fontSize: 11,
                        fontWeight: 600,
                        padding: "4px 10px",
                        borderRadius: 4,
                        cursor: isBusy ? "not-allowed" : "pointer",
                      }}
                    >
                      {fix?.status === "loading"
                        ? "Thinking…"
                        : fix?.status === "streaming"
                          ? "Streaming…"
                          : fix?.status === "stopping"
                            ? "Stopping…"
                            : fix?.status === "done" ||
                                fix?.status === "error" ||
                                fix?.status === "cancelled"
                              ? "Ask again"
                              : "Ask AI to fix"}
                    </button>
                    {isBusy && (
                      // Stop button — only shown while the model is actively
                      // generating. Hitting it flips `fix.status` to
                      // 'stopping' optimistically (so the label/disabled
                      // change is instant) and aborts the stream. The Rust
                      // side emits `llm-cancel` shortly after and the
                      // streamChat `onCancel` transitions to 'cancelled'
                      // with the authoritative partial text. During the
                      // stopping phase we keep the button visible but
                      // disabled so the user isn't tempted to click again.
                      <button
                        type="button"
                        onClick={() => cancelFix(f.id)}
                        disabled={isStopping}
                        title={
                          isStopping
                            ? "Waiting for the provider to flush and close…"
                            : "Stop the AI from generating more output"
                        }
                        style={{
                          background: "var(--bg-panel)",
                          border: `1px solid ${isStopping ? "var(--danger-border)" : "var(--danger)"}`,
                          color: isStopping ? "var(--text-muted)" : "var(--danger)",
                          fontSize: 11,
                          fontWeight: 600,
                          padding: "4px 10px",
                          borderRadius: 4,
                          cursor: isStopping ? "not-allowed" : "pointer",
                          opacity: isStopping ? 0.7 : 1,
                        }}
                      >
                        {isStopping ? "Stopping…" : "Stop"}
                      </button>
                    )}
                    {fix && !isBusy && (
                      <button
                        type="button"
                        onClick={() => dismissFix(f.id)}
                        style={{
                          background: "none",
                          border: "1px solid var(--border-input)",
                          color: "var(--text-tertiary)",
                          fontSize: 11,
                          fontWeight: 600,
                          padding: "4px 10px",
                          borderRadius: 4,
                          cursor: "pointer",
                        }}
                      >
                        Dismiss
                      </button>
                    )}
                  </div>
                </div>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: "var(--text-primary)",
                    marginBottom: 4,
                  }}
                >
                  {f.title}
                </div>
                <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>
                  {f.message}
                </div>
                {f.filePath && (
                  <div
                    style={{
                      marginTop: 8,
                      fontSize: 11,
                      fontFamily: "ui-monospace, monospace",
                      color: "var(--text-tertiary)",
                      wordBreak: "break-all",
                    }}
                    title={f.filePath}
                  >
                    📄 {f.filePath}
                  </div>
                )}

                {openErrors[f.id] && (
                  <div
                    style={{
                      marginTop: 8,
                      padding: "6px 10px",
                      background: "var(--danger-soft)",
                      border: "1px solid var(--danger-border)",
                      borderRadius: 6,
                      fontSize: 11,
                      color: "var(--danger)",
                    }}
                  >
                    Couldn't open in editor: {openErrors[f.id]}
                  </div>
                )}

                {fix && (
                  <div
                    style={{
                      marginTop: 12,
                      padding: 12,
                      borderRadius: 6,
                      background:
                        fix.status === "error"
                          ? "var(--danger-soft)"
                          : fix.status === "cancelled"
                            ? "var(--warning-soft)"
                            : "var(--bg-elevated)",
                      border: `1px solid ${
                        fix.status === "error"
                          ? "var(--danger-border)"
                          : fix.status === "cancelled"
                            ? "var(--warning-soft)"
                            : "var(--border-subtle)"
                      }`,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        marginBottom: 6,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          textTransform: "uppercase",
                          letterSpacing: 0.4,
                          color:
                            fix.status === "error"
                              ? "var(--danger)"
                              : fix.status === "cancelled"
                                ? "var(--warning)"
                                : "var(--accent)",
                        }}
                      >
                        {fix.status === "error"
                          ? "Error"
                          : fix.status === "cancelled"
                            ? "Cancelled (partial)"
                            : fix.status === "loading"
                              ? "Preparing…"
                              : fix.status === "streaming"
                                ? "AI fix (streaming)"
                                : fix.status === "stopping"
                                  ? "Stopping…"
                                  : "AI fix"}
                      </span>
                      {(fix.status === "done" || fix.status === "cancelled") && fix.text && (
                        <button
                          type="button"
                          onClick={() => copyFix(fix.text)}
                          style={{
                            background: "none",
                            border: "none",
                            color: "var(--accent)",
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: "pointer",
                            padding: 0,
                          }}
                        >
                          Copy
                        </button>
                      )}
                    </div>
                    {fix.status === "error" ? (
                      <div style={{ fontSize: 12, color: "var(--danger)" }}>
                        {fix.error || "Unknown error"}
                      </div>
                    ) : fix.status === "loading" && !fix.text ? (
                      <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                        Reading file and picking a provider…
                      </div>
                    ) : fix.status === "done" || fix.status === "cancelled" ? (
                      // Render the final text as markdown — fixes usually
                      // include fenced code blocks, numbered rationale
                      // steps, and headings that are hard to scan as
                      // plain text. Safe: renderMarkdown escapes first,
                      // then injects its own emitted tags only. Cancelled
                      // partials get the same treatment; they may have a
                      // truncated code fence but the renderer tolerates it.
                      <div
                        style={{
                          fontSize: 13,
                          lineHeight: 1.55,
                          color: "var(--text-primary)",
                        }}
                        dangerouslySetInnerHTML={{
                          __html: renderMarkdown(fix.text),
                        }}
                      />
                    ) : (
                      // While streaming we show plain <pre> so partial
                      // code fences / lists don't flicker through half-
                      // rendered states as tokens arrive.
                      <pre
                        style={{
                          margin: 0,
                          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                          fontSize: 12,
                          lineHeight: 1.55,
                          color: "var(--text-primary)",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                        }}
                      >
                        {fix.text}
                        {fix.status === "streaming" && (
                          <span style={{ color: "var(--accent)" }}>▍</span>
                        )}
                        {fix.status === "stopping" && (
                          // Faded cursor while we wait for the cancel event —
                          // signals that the stream is winding down without
                          // implying active generation.
                          <span style={{ color: "var(--border-input)" }}>▍</span>
                        )}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stage-runner helper components (audit + build adoption)
// ---------------------------------------------------------------------------

function runnerBtnStyle(busy: boolean, missingCtx: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    background: busy ? "var(--bg-elevated)" : "var(--accent-soft)",
    border: `1px solid ${busy ? "var(--border-subtle)" : "var(--accent-soft)"}`,
    color: busy ? "var(--text-muted)" : "var(--accent-hover)",
    borderRadius: 6,
    fontWeight: 600,
    fontSize: 12,
    cursor: busy || missingCtx ? "not-allowed" : "pointer",
    whiteSpace: "nowrap",
  };
}
