/**
 * PendingReviewsPanel
 *
 * Sister to PipelineStatusPanel. Lists ALL pending review gates
 * across every stage in one place so the user doesn't have to walk
 * through each tab to find them. Inline Approve / Reject buttons
 * call the same desktop helpers the AdvanceConfirmModal uses, so
 * approving here advances both stage-progress.json AND the SQLite
 * venture stage (via the onAdvanceStage callback wired from the
 * parent).
 *
 * Lives in the existing "pipeline" tab in VentureDashboard, above
 * PipelineStatusPanel. Hidden when there are no pending gates so
 * the tab stays uncluttered for ventures that haven't accumulated
 * any.
 *
 * Refresh trigger: parent passes a `refreshToken` -- bump it after
 * approve/reject to re-read the gates file. The panel also bumps
 * its OWN local refresh tick after each successful action so the
 * approved/rejected gate disappears immediately from the list.
 */
import type { ReviewGate, VentureStage } from "@founder-os/domain";
import { STAGE_PRODUCES } from "@founder-os/domain";
import { useEffect, useState } from "react";
import { approveReviewGate, loadReviewGates, rejectReviewGate } from "../../lib/review-gates.js";
import { pushToast } from "../../lib/toasts.js";

type PendingReviewsPanelProps = {
  ventureRoot: string;
  /**
   * Bump to force a re-read. Parent typically passes the same token
   * it bumps after stage runs (artifactsRescanToken in
   * VentureDashboard) so this panel refreshes when a runner emits
   * a new gate.
   */
  refreshToken?: number;
  /**
   * Wired from VentureDashboard's handleStageChange. Called after a
   * successful approve so the SQLite venture stage advances to the
   * marker the gate produces (looked up via STAGE_PRODUCES). Without
   * this, approving here would only update gate file +
   * stage-progress.json -- the venture row would lag.
   */
  onAdvanceStage: (stage: VentureStage) => void;
};

export function PendingReviewsPanel({
  ventureRoot,
  refreshToken = 0,
  onAdvanceStage,
}: PendingReviewsPanelProps) {
  const [gates, setGates] = useState<ReviewGate[]>([]);
  const [busyGate, setBusyGate] = useState<string | null>(null);
  const [localTick, setLocalTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps intentionally omitted
  useEffect(() => {
    let cancelled = false;
    loadReviewGates(ventureRoot)
      .then((all) => {
        if (cancelled) return;
        setGates(all.filter((g) => g.status === "pending"));
      })
      .catch(() => {
        if (!cancelled) setGates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [ventureRoot, refreshToken, localTick]);

  const handleApprove = async (gate: ReviewGate) => {
    if (busyGate !== null) return;
    setBusyGate(gate.gateId);
    try {
      await approveReviewGate(ventureRoot, gate.gateId, "desktop-user");
      // STAGE_PRODUCES tells us the VentureStage the gate's stage
      // produces (e.g. BRAND -> BRAND_READY). Advance the venture
      // row in SQLite so the rest of the desktop reflects it.
      const ventureStage = STAGE_PRODUCES[gate.stageName];
      if (ventureStage) onAdvanceStage(ventureStage);
      pushToast({
        kind: "success",
        message: `${gate.stageName} stage approved`,
        detail: ventureStage ? `Venture advanced to ${ventureStage}.` : undefined,
        ttlMs: 5000,
      });
      setLocalTick((n) => n + 1);
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Couldn't approve review gate",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyGate(null);
    }
  };

  const handleReject = async (gate: ReviewGate) => {
    if (busyGate !== null) return;
    setBusyGate(gate.gateId);
    try {
      await rejectReviewGate(ventureRoot, gate.gateId, "desktop-user");
      pushToast({
        kind: "info",
        message: `${gate.stageName} review rejected`,
        detail: "Re-run the stage to produce a fresh review.",
        ttlMs: 5000,
      });
      setLocalTick((n) => n + 1);
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Couldn't reject review gate",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyGate(null);
    }
  };

  if (gates.length === 0) return null;

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
        <span style={{ fontWeight: 700 }}>Pending review gates</span>
        <span>{gates.length} pending</span>
      </div>
      <div
        style={{
          border: "1px solid var(--border-subtle)",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        {gates.map((gate, idx) => (
          <PendingReviewRow
            key={gate.gateId}
            gate={gate}
            isLast={idx === gates.length - 1}
            busy={busyGate === gate.gateId}
            disabled={busyGate !== null && busyGate !== gate.gateId}
            onApprove={() => handleApprove(gate)}
            onReject={() => handleReject(gate)}
          />
        ))}
      </div>
    </div>
  );
}

function PendingReviewRow({
  gate,
  isLast,
  busy,
  disabled,
  onApprove,
  onReject,
}: {
  gate: ReviewGate;
  isLast: boolean;
  busy: boolean;
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "12px 14px",
        borderBottom: isLast ? "none" : "1px solid var(--border-subtle)",
        background: "var(--bg-panel)",
        fontSize: 13,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span
            style={{
              fontFamily: "ui-monospace, monospace",
              fontWeight: 700,
              fontSize: 12,
              color: "var(--text-secondary)",
            }}
          >
            {gate.stageName}
          </span>
          <span
            style={{
              padding: "2px 6px",
              borderRadius: 4,
              background: "var(--accent-soft)",
              color: "var(--accent-hover)",
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            {gate.requiredApproval} review
          </span>
          <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
            run {gate.runId} -- {new Date(gate.createdAt).toLocaleString()}
          </span>
        </div>
        {gate.artifactsForReview.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {gate.artifactsForReview.map((a) => (
              <span
                key={a.path}
                style={{
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 11,
                  color: "var(--text-secondary)",
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border-subtle)",
                  padding: "2px 6px",
                  borderRadius: 4,
                  wordBreak: "break-all",
                }}
                title={a.path}
              >
                {a.type}: {a.path}
              </span>
            ))}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        <button
          type="button"
          onClick={onReject}
          disabled={busy || disabled}
          style={{
            padding: "6px 12px",
            background: "var(--bg-panel)",
            color: "var(--danger)",
            border: "1px solid var(--danger-border)",
            borderRadius: 6,
            fontWeight: 600,
            fontSize: 12,
            cursor: busy || disabled ? "not-allowed" : "pointer",
          }}
        >
          {busy ? "..." : "Reject"}
        </button>
        <button
          type="button"
          onClick={onApprove}
          disabled={busy || disabled}
          style={{
            padding: "6px 14px",
            background: "var(--accent)",
            color: "var(--bg-panel)",
            border: "none",
            borderRadius: 6,
            fontWeight: 700,
            fontSize: 12,
            cursor: busy || disabled ? "not-allowed" : "pointer",
          }}
        >
          {busy ? "Approving..." : "Approve & advance"}
        </button>
      </div>
    </div>
  );
}
