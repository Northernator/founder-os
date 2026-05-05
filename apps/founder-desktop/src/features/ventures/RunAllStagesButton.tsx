/**
 * RunAllStagesButton
 *
 * Single-click "run every implemented stage in order" entry point.
 * Sits in VentureDashboard's pipeline tab between PendingReviewsPanel
 * and PipelineStatusPanel. Uses the runAllStages helper which
 * iterates the run-X-stage helpers with force=false so already-
 * complete stages short-circuit -- a re-click of "Run all" only
 * does work that's missing.
 *
 * UI surface:
 *   - Idle: "Run all stages" CTA
 *   - In flight: "Running <STAGE>..." + Stop button
 *   - End: dismissable summary line ("4 succeeded, stopped at BRAND
 *          (review needed)")
 *
 * The summary toast at the end is the canonical "what happened"
 * receipt; this component's local summary line is the persistent
 * one the user can re-read.
 */
import type { StageName, Venture, VentureManifest } from "@founder-os/domain";
import { useRef, useState } from "react";
import {
  type RunAllStagesResult,
  type StageOutcome,
  runAllStages,
} from "../../lib/run-all-stages.js";
import { pushToast } from "../../lib/toasts.js";

type RunAllStagesButtonProps = {
  venture: Venture;
  manifest: VentureManifest | null;
  /**
   * Concatenated chat transcript + attachment blocks. Required for
   * the RESEARCH stage on saas ventures; ignored otherwise. The
   * helper skips RESEARCH with a clear reason if missing.
   */
  intake?: string;
  /**
   * Bumped after the loop completes so the parent can refresh
   * downstream state (PipelineStatusPanel re-reads, artifact list
   * re-scans, etc).
   */
  onAllDone?: () => void;
};

export function RunAllStagesButton({
  venture,
  manifest,
  intake,
  onAllDone,
}: RunAllStagesButtonProps) {
  const [busy, setBusy] = useState(false);
  const [currentStage, setCurrentStage] = useState<StageName | null>(null);
  const [summary, setSummary] = useState<RunAllStagesResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const handleRun = async () => {
    if (busy) return;
    if (!manifest) {
      pushToast({
        kind: "warn",
        message: "Venture manifest not ready",
        detail: "Try again in a moment.",
        ttlMs: 5000,
      });
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setCurrentStage(null);
    setSummary(null);
    pushToast({
      kind: "info",
      message: "Running all stages...",
      detail: "Stops on first failure, pending review, or missing provider.",
      ttlMs: 4000,
    });
    try {
      const result = await runAllStages({
        venture,
        manifest,
        signal: controller.signal,
        ...(intake !== undefined ? { intake } : {}),
        onStageStart: (stage) => {
          setCurrentStage(stage);
        },
      });
      setSummary(result);
      pushToast(toastForResult(result));
      onAllDone?.();
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Run all stages failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
      setCurrentStage(null);
      abortRef.current = null;
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button
          type="button"
          onClick={handleRun}
          disabled={busy || !manifest}
          title="Run every implemented stage in order. Already-complete stages skip."
          style={{
            padding: "8px 16px",
            background: busy ? "var(--bg-elevated)" : "var(--accent)",
            color: busy ? "var(--text-muted)" : "var(--bg-panel)",
            border: "none",
            borderRadius: 6,
            fontWeight: 700,
            fontSize: 13,
            cursor: busy || !manifest ? "not-allowed" : "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {busy ? (currentStage ? `Running ${currentStage}...` : "Running...") : "Run all stages"}
        </button>
        {busy && (
          <button
            type="button"
            onClick={handleStop}
            style={{
              padding: "8px 14px",
              background: "var(--bg-panel)",
              color: "var(--danger)",
              border: "1px solid var(--danger-border)",
              borderRadius: 6,
              fontWeight: 600,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Stop
          </button>
        )}
        {summary && !busy && <SummaryLine summary={summary} />}
      </div>
    </div>
  );
}

function SummaryLine({ summary }: { summary: RunAllStagesResult }) {
  const succeeded = summary.outcomes.filter((o) => o.status === "success").length;
  const skipped = summary.outcomes.filter((o) => o.status === "skipped").length;
  const stopAt = summary.outcomes.find(
    (o) =>
      o.status === "failure" ||
      o.status === "review-needed" ||
      o.status === "no-provider" ||
      o.status === "aborted"
  );
  const stopMsg =
    stopAt &&
    `${stopAt.stage}: ${stopAt.status === "review-needed" ? "review needed" : stopAt.status}`;
  return (
    <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
      {succeeded} succeeded
      {skipped > 0 ? `, ${skipped} skipped` : ""}
      {stopMsg ? ` -- stopped at ${stopMsg}` : " -- completed"}
    </span>
  );
}

function toastForResult(result: RunAllStagesResult): Parameters<typeof pushToast>[0] {
  const succeeded = result.outcomes.filter((o) => o.status === "success").length;
  if (result.stoppedBecause === "completed") {
    return {
      kind: "success",
      message: `Run all complete (${succeeded} stages)`,
      detail: "Pipeline tab shows the full state.",
      ttlMs: 8000,
    };
  }
  const stopAt = lastOutcome(result.outcomes);
  return {
    kind: result.stoppedBecause === "review-needed" ? "info" : "warn",
    message: `Stopped at ${stopAt.stage}: ${describeStop(stopAt)}`,
    detail: `${succeeded} prior stages completed.`,
    ttlMs: 8000,
  };
}

function lastOutcome(outcomes: StageOutcome[]): StageOutcome {
  return outcomes[outcomes.length - 1] as StageOutcome;
}

function describeStop(o: StageOutcome): string {
  switch (o.status) {
    case "failure":
      return o.result.error?.message ?? "failure";
    case "review-needed":
      return "pending review gate";
    case "no-provider":
      return "no AI provider configured";
    case "aborted":
      return "user stopped";
    default:
      return o.status;
  }
}
