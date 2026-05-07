/**
 * FailedRunBanner
 *
 * Shared retry-failed-run banner. Used by every tab that surfaces a
 * stage's most recent FailedRunEntry. Render only when entry is non-
 * null (the parent decides whether to render).
 *
 * Why this lives in its own file: BrandTab / ResearchTab / SpecTab /
 * ScreensTab / UkSetupTab / AuditTab all hand-rolled the same banner
 * inline before this. Lifting it here removes ~150 LOC of duplication
 * and centralises the look so future UX changes (icon swap, layout
 * tweak, accessibility improvements) happen once.
 *
 * Layout:
 *   - `gridSpan` prop adds `gridColumn: "1 / -1"` so the banner spans
 *     the parent grid in 2-col layouts (Spec, Screens, UkSetup).
 *     The non-grid tabs (Brand, Research, Audit) leave it false.
 *   - The banner has its own danger-soft container + bottom margin
 *     so consumers don't need a wrapper.
 *
 * Actions in the banner header (right-aligned):
 *   - "View dump" -- opens the per-run StageRunResult JSON in the OS
 *     file manager so the user can inspect the full logs + stack.
 *   - "Dismiss"   -- removes the entry from .founder/state/failed-runs.json
 *     without retrying. Useful when the user has seen the failure,
 *     decided to act manually, and wants the banner to disappear.
 *   - "Retry stage" -- the original retry CTA.
 */
import type { FailedRunEntry } from "@founder-os/domain";
import { getFailedStageResultPath } from "@founder-os/workspace-core";
import { useState } from "react";
import { markFailedRunResolved } from "../../lib/failed-runs.js";
import { pushToast } from "../../lib/toasts.js";
import { openInFileManager } from "../../lib/venture-io.js";

export type FailedRunBannerProps = {
  /**
   * Short stage label rendered in the headline -- e.g. "brand" ->
   * "Last brand stage run failed". Lowercase. The component does
   * NOT capitalise; pass exactly what you want to read.
   */
  label: string;
  entry: FailedRunEntry;
  /**
   * Venture root path. Used to compute the per-run dump path
   * (.founder/handoffs/failed/<stage>-<run>.result.json) and to call
   * markFailedRunResolved on Dismiss.
   */
  ventureRoot: string;
  /** True while the parent is running this stage (disables Retry). */
  busy: boolean;
  /**
   * True when the parent can't run the stage right now (manifest not
   * loaded, no venture context, etc). Disables Retry; cursor + tooltip
   * communicate the reason via the parent's existing structure.
   */
  disabled?: boolean;
  /** Retry click handler. Typically the same handler the run button uses. */
  onRetry: () => void;
  /**
   * Optional callback fired after a successful Dismiss (the entry has
   * been removed from failed-runs.json). Parent re-reads its
   * findLatestFailedRunForStage state so the banner disappears
   * without waiting on the global refreshToken.
   */
  onDismissed?: () => void;
  /**
   * When true the banner adds `gridColumn: "1 / -1"` so it spans
   * across the parent CSS grid. Used by SpecTab / ScreensTab /
   * UkSetupTab which are 2-col layouts. Default false.
   */
  gridSpan?: boolean;
};

export function FailedRunBanner({
  label,
  entry,
  ventureRoot,
  busy,
  disabled = false,
  onRetry,
  onDismissed,
  gridSpan = false,
}: FailedRunBannerProps) {
  const [dismissing, setDismissing] = useState(false);

  const handleViewDump = async () => {
    const dumpPath = getFailedStageResultPath(ventureRoot, entry.stageName, entry.runId);
    try {
      await openInFileManager(dumpPath);
    } catch (err) {
      pushToast({
        kind: "warn",
        message: "Couldn't open dump file",
        detail: err instanceof Error ? err.message : String(err),
        ttlMs: 5000,
      });
    }
  };

  const handleDismiss = async () => {
    if (dismissing || busy) return;
    setDismissing(true);
    try {
      await markFailedRunResolved(ventureRoot, entry.stageName, entry.runId);
      pushToast({
        kind: "info",
        message: `${label} run dismissed`,
        detail: "Cleared from failed-runs index. The dump file stays on disk.",
        ttlMs: 4000,
      });
      onDismissed?.();
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Couldn't dismiss failed run",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDismissing(false);
    }
  };

  const actionsDisabled = busy || dismissing;

  return (
    <div
      style={{
        ...(gridSpan ? { gridColumn: "1 / -1" } : {}),
        background: "var(--danger-soft)",
        border: "1px solid var(--danger-border)",
        borderRadius: 8,
        padding: "10px 14px",
        marginBottom: 16,
        display: "flex",
        alignItems: "center",
        gap: 12,
        fontSize: 13,
      }}
    >
      <span style={{ fontSize: 18 }}>!</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, color: "var(--danger)" }}>Last {label} stage run failed</div>
        <div
          style={{
            color: "var(--text-secondary)",
            fontSize: 12,
            marginTop: 2,
            wordBreak: "break-word",
          }}
        >
          {entry.errorCode}: {entry.errorMessage}
          <span style={{ marginLeft: 8, color: "var(--text-tertiary)" }}>
            run {entry.runId} -- {new Date(entry.failedAt).toLocaleString()}
          </span>
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
        <button
          type="button"
          onClick={handleViewDump}
          title="Reveal the per-run dump file in your OS file manager"
          style={{
            padding: "6px 10px",
            background: "var(--bg-panel)",
            color: "var(--text-secondary)",
            border: "1px solid var(--border-input)",
            borderRadius: 6,
            fontWeight: 600,
            fontSize: 12,
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          View dump
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          disabled={actionsDisabled}
          title="Clear this failed run from the index without retrying"
          style={{
            padding: "6px 10px",
            background: "var(--bg-panel)",
            color: "var(--text-secondary)",
            border: "1px solid var(--border-input)",
            borderRadius: 6,
            fontWeight: 600,
            fontSize: 12,
            cursor: actionsDisabled ? "not-allowed" : "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {dismissing ? "..." : "Dismiss"}
        </button>
        <button
          type="button"
          onClick={onRetry}
          disabled={busy || disabled || dismissing}
          style={{
            padding: "8px 14px",
            background: "var(--danger)",
            color: "var(--bg-panel)",
            border: "none",
            borderRadius: 6,
            fontWeight: 700,
            fontSize: 13,
            cursor: busy || disabled || dismissing ? "not-allowed" : "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {busy ? "Retrying..." : "Retry stage"}
        </button>
      </div>
    </div>
  );
}
