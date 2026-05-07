/**
 * PipelineStatusPanel
 *
 * Read-only overview of all 11 stage-runner stages for one venture.
 * Surfaces in one view what previously required clicking through
 * 7 different tabs:
 *   - which stages have completed (from .founder/state/stage-progress.json)
 *   - the current cursor (latest completed stage)
 *   - any pending review gates (from .founder/state/review-gates.json)
 *   - the most recent failed run per stage (from .founder/state/failed-runs.json)
 *
 * Lives in the existing "pipeline" tab in VentureDashboard. Sits
 * above the legacy StageGraph + active-run-history views so users
 * see the new picture first while the old one is still useful for
 * click-to-advance + last-pipeline-run details.
 *
 * V1 is read-only -- click-to-act lives in each stage's tab. A
 * future iteration could add inline "Run X stage" buttons or jump-
 * to-tab links, but those introduce coupling we don't need yet.
 */
import type { FailedRunEntry, ReviewGate, StageName, StageProgress } from "@founder-os/domain";
import { STAGE_NAME_ORDER } from "@founder-os/domain";
import { getStageProgressPath } from "@founder-os/workspace-core";
import type React from "react";
import { useEffect, useState } from "react";
import { loadFailedRuns } from "../../lib/failed-runs.js";
import { tauriFs } from "../../lib/pipeline-fs.js";
import { loadReviewGates } from "../../lib/review-gates.js";

type PipelineStatusPanelProps = {
  ventureRoot: string;
  /**
   * Bump this prop value to force a re-read. The panel reads on
   * mount + venture switch + every refreshToken change. Pass the
   * same token VentureDashboard already bumps after stage runs.
   */
  refreshToken?: number;
  /**
   * Called when a stage row is clicked. When provided, rows render
   * as buttons with hover/pointer affordance. Parent decides what
   * happens (typically setTab to the matching tab; stages with no
   * home tab can toast or be a no-op). Omit for a fully read-only
   * panel.
   */
  onSelectStage?: (stage: StageName) => void;
};

type StageRow = {
  name: StageName;
  status: "complete" | "current" | "pending";
  pendingGate: ReviewGate | null;
  latestFailedRun: FailedRunEntry | null;
};

export function PipelineStatusPanel({
  ventureRoot,
  refreshToken = 0,
  onSelectStage,
}: PipelineStatusPanelProps) {
  const [progress, setProgress] = useState<StageProgress | null>(null);
  const [gates, setGates] = useState<ReviewGate[]>([]);
  const [failedRuns, setFailedRuns] = useState<FailedRunEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps intentionally omitted
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        // Stage-progress lives at .founder/state/stage-progress.json.
        // Read directly via tauriFs to avoid the orchestrator
        // construction overhead (which needs a manifest in scope).
        const progressPath = getStageProgressPath(ventureRoot);
        let nextProgress: StageProgress | null = null;
        if (await tauriFs.exists(progressPath)) {
          try {
            const raw = await tauriFs.readFile(progressPath);
            nextProgress = JSON.parse(raw) as StageProgress;
          } catch {
            // Malformed file -- treat as "no progress" so the panel
            // still renders the empty state instead of throwing.
            nextProgress = null;
          }
        }
        const [nextGates, nextFailed] = await Promise.all([
          loadReviewGates(ventureRoot),
          loadFailedRuns(ventureRoot),
        ]);
        if (cancelled) return;
        setProgress(nextProgress);
        setGates(nextGates);
        setFailedRuns(nextFailed);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ventureRoot, refreshToken]);

  if (loading) {
    return (
      <div style={{ fontSize: 13, color: "var(--text-tertiary)" }}>Loading pipeline status...</div>
    );
  }
  if (error) {
    return (
      <div style={{ fontSize: 13, color: "var(--danger)" }}>
        Couldn't load pipeline status: {error}
      </div>
    );
  }

  const completed = new Set(progress?.completedStages ?? []);
  const cursor = progress?.currentStage ?? null;
  const rows: StageRow[] = STAGE_NAME_ORDER.map((name) => {
    let status: StageRow["status"] = "pending";
    if (completed.has(name)) status = "complete";
    else if (name === cursor) status = "current";
    const pendingGate =
      gates
        .filter((g) => g.stageName === name && g.status === "pending")
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] ?? null;
    const latestFailedRun =
      failedRuns
        .filter((e) => e.stageName === name)
        .sort((a, b) => (a.failedAt < b.failedAt ? 1 : -1))[0] ?? null;
    return { name, status, pendingGate, latestFailedRun };
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 24 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 12,
          color: "var(--text-tertiary)",
        }}
      >
        <span style={{ fontWeight: 700 }}>Stage runner status (read-only)</span>
        <span>
          {completed.size}/{STAGE_NAME_ORDER.length} complete
          {cursor ? ` · cursor: ${cursor}` : ""}
        </span>
      </div>
      <div
        style={{
          border: "1px solid var(--border-subtle)",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        {rows.map((row, idx) => (
          <PipelineStatusRow
            key={row.name}
            row={row}
            isLast={idx === rows.length - 1}
            onSelect={onSelectStage}
          />
        ))}
      </div>
    </div>
  );
}

function PipelineStatusRow({
  row,
  isLast,
  onSelect,
}: {
  row: StageRow;
  isLast: boolean;
  onSelect?: (stage: StageName) => void;
}) {
  const clickable = onSelect !== undefined;
  const statusBadge = (() => {
    switch (row.status) {
      case "complete":
        return { label: "complete", color: "var(--success)", bg: "var(--success-soft)" };
      case "current":
        return { label: "current", color: "var(--accent)", bg: "var(--accent-soft)" };
      case "pending":
        return { label: "pending", color: "var(--text-tertiary)", bg: "var(--bg-elevated)" };
    }
  })();

  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 14px",
    borderBottom: isLast ? "none" : "1px solid var(--border-subtle)",
    background: "var(--bg-panel)",
    fontSize: 13,
    width: "100%",
    textAlign: "left",
    border: "none",
    color: "inherit",
    font: "inherit",
    cursor: clickable ? "pointer" : "default",
  };
  const handleClick = clickable ? () => onSelect?.(row.name) : undefined;
  return clickable ? (
    <button type="button" style={rowStyle} onClick={handleClick}>
      <span
        style={{
          fontFamily: "ui-monospace, monospace",
          fontWeight: 700,
          fontSize: 12,
          color: "var(--text-secondary)",
          minWidth: 130,
        }}
      >
        {row.name}
      </span>
      <span
        style={{
          padding: "2px 8px",
          borderRadius: 4,
          background: statusBadge.bg,
          color: statusBadge.color,
          fontSize: 11,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {statusBadge.label}
      </span>
      <div style={{ flex: 1, minWidth: 0, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {row.pendingGate && (
          <span
            style={{
              fontSize: 11,
              padding: "2px 6px",
              borderRadius: 4,
              background: "var(--accent-soft)",
              color: "var(--accent-hover)",
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
            title={`Review gate ${row.pendingGate.gateId} created ${row.pendingGate.createdAt}`}
          >
            review pending ({row.pendingGate.requiredApproval})
          </span>
        )}
        {row.latestFailedRun && (
          <span
            style={{
              fontSize: 11,
              padding: "2px 6px",
              borderRadius: 4,
              background: "var(--danger-soft)",
              color: "var(--danger)",
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
            title={`${row.latestFailedRun.errorCode}: ${row.latestFailedRun.errorMessage} (run ${row.latestFailedRun.runId} at ${row.latestFailedRun.failedAt})`}
          >
            last run failed
          </span>
        )}
      </div>
    </button>
  ) : (
    <div style={rowStyle}>
      <span
        style={{
          fontFamily: "ui-monospace, monospace",
          fontWeight: 700,
          fontSize: 12,
          color: "var(--text-secondary)",
          minWidth: 130,
        }}
      >
        {row.name}
      </span>
      <span
        style={{
          padding: "2px 8px",
          borderRadius: 4,
          background: statusBadge.bg,
          color: statusBadge.color,
          fontSize: 11,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {statusBadge.label}
      </span>
      <div style={{ flex: 1, minWidth: 0, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {row.pendingGate && (
          <span
            style={{
              fontSize: 11,
              padding: "2px 6px",
              borderRadius: 4,
              background: "var(--accent-soft)",
              color: "var(--accent-hover)",
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
            title={`Review gate ${row.pendingGate.gateId} created ${row.pendingGate.createdAt}`}
          >
            review pending ({row.pendingGate.requiredApproval})
          </span>
        )}
        {row.latestFailedRun && (
          <span
            style={{
              fontSize: 11,
              padding: "2px 6px",
              borderRadius: 4,
              background: "var(--danger-soft)",
              color: "var(--danger)",
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
            title={`${row.latestFailedRun.errorCode}: ${row.latestFailedRun.errorMessage} (run ${row.latestFailedRun.runId} at ${row.latestFailedRun.failedAt})`}
          >
            last run failed
          </span>
        )}
      </div>
    </div>
  );
}
