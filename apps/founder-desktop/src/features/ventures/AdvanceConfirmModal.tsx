import type { VentureStage } from "@founder-os/domain";
import { invoke } from "@tauri-apps/api/core";
import type React from "react";
import { useState } from "react";
import * as db from "../../lib/db.js";
import { pushToast } from "../../lib/toasts.js";

/**
 * Modal that gates the per-tab "Advance to next stage" button on the
 * results of a pre-flight audit. Three states, picked by the caller
 * before opening:
 *
 *   blockers > 0           → "Cannot advance" — list blockers, no advance
 *                            button. Each row offers a Fix link that
 *                            opens the offending file in the user's
 *                            preferred editor (same plumbing AuditTab
 *                            uses for "Open file").
 *   blockers === 0,
 *   warnings > 0           → "Advance with N warning(s)?" — list
 *                            warnings, primary button = "Advance anyway".
 *   blockers === 0,
 *   warnings === 0         → callers shouldn't open the modal at all.
 *                            We render a neutral fallback just in case.
 *
 * Findings come in already persisted (advance-gate.ts wrote them via
 * insertAuditFindings before resolving), so the AuditTab reflects them
 * the next time it's opened.
 */

const SEVERITY_COLORS: Record<
  db.FindingRow["severity"],
  { bg: string; border: string; text: string; label: string }
> = {
  critical: { bg: "var(--danger-soft)", border: "var(--danger-border)", text: "var(--danger)", label: "Critical" },
  high: { bg: "var(--warning-soft)", border: "var(--warning-soft)", text: "var(--warning)", label: "High" },
  medium: { bg: "var(--accent-soft)", border: "var(--accent)", text: "var(--accent)", label: "Medium" },
  low: { bg: "var(--bg-hover)", border: "var(--border-input)", text: "var(--text-secondary)", label: "Low" },
};

const SEVERITY_ORDER: db.FindingRow["severity"][] = ["critical", "high", "medium", "low"];

function formatStage(stage: VentureStage): string {
  return stage.replace(/_/g, " ");
}

export function AdvanceConfirmModal({
  blockers,
  warnings,
  currentStage,
  nextStage,
  onAdvance,
  onClose,
}: {
  blockers: db.FindingRow[];
  warnings: db.FindingRow[];
  currentStage: VentureStage;
  nextStage: VentureStage;
  onAdvance: () => void;
  onClose: () => void;
}) {
  const [advancing, setAdvancing] = useState(false);
  const [openErrors, setOpenErrors] = useState<Record<string, string>>({});

  const hasBlockers = blockers.length > 0;
  const hasWarnings = warnings.length > 0;

  const handleOpenFile = async (finding: db.FindingRow) => {
    if (!finding.filePath) return;
    setOpenErrors((prev) => {
      const next = { ...prev };
      delete next[finding.id];
      return next;
    });
    try {
      const preferredEditor = await db.getEditorCommand();
      await invoke("open_in_editor", {
        path: finding.filePath,
        preferredEditor: preferredEditor ?? undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setOpenErrors((prev) => ({ ...prev, [finding.id]: msg }));
      pushToast({
        kind: "warn",
        message: "Couldn't open file in editor",
        detail: msg,
      });
    }
  };

  const handleAdvance = () => {
    if (advancing || hasBlockers) return;
    setAdvancing(true);
    onAdvance();
  };

  const groupedBlockers = groupBySeverity(blockers);
  const groupedWarnings = groupBySeverity(warnings);

  const title = hasBlockers
    ? `Cannot advance to ${formatStage(nextStage)}`
    : hasWarnings
      ? `Advance to ${formatStage(nextStage)} with ${warnings.length} warning${
          warnings.length === 1 ? "" : "s"
        }?`
      : `Advance to ${formatStage(nextStage)}?`;

  const subtitle = hasBlockers
    ? `${blockers.length} blocking issue${blockers.length === 1 ? "" : "s"} must be resolved before this stage can be marked complete.`
    : hasWarnings
      ? "These items don't block the advance, but you might want to address them first."
      : `Currently at ${formatStage(currentStage)}.`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="advance-modal-title"
      onClick={advancing ? undefined : onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-panel)",
          borderRadius: 12,
          padding: 24,
          width: "min(640px, calc(100vw - 32px))",
          maxHeight: "calc(100vh - 64px)",
          boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <h2
            id="advance-modal-title"
            style={{
              margin: 0,
              fontSize: 18,
              fontWeight: 800,
              color: hasBlockers ? "var(--danger)" : "var(--text-primary)",
            }}
          >
            {hasBlockers ? "🛑 " : hasWarnings ? "⚠️ " : ""}
            {title}
          </h2>
          <p style={{ margin: 0, fontSize: 13, color: "var(--text-tertiary)" }}>{subtitle}</p>
        </div>

        <div
          style={{
            flex: 1,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 14,
            paddingRight: 4,
          }}
        >
          {hasBlockers && (
            <FindingGroup
              heading="Blockers"
              groups={groupedBlockers}
              openErrors={openErrors}
              onOpenFile={handleOpenFile}
            />
          )}
          {hasWarnings && (
            <FindingGroup
              heading={hasBlockers ? "Other issues" : "Warnings"}
              groups={groupedWarnings}
              openErrors={openErrors}
              onOpenFile={handleOpenFile}
            />
          )}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            paddingTop: 8,
            borderTop: "1px solid var(--bg-hover)",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={advancing}
            style={{
              padding: "9px 16px",
              background: "var(--bg-panel)",
              color: "var(--text-secondary)",
              border: "1px solid var(--border-input)",
              borderRadius: 6,
              fontWeight: 600,
              fontSize: 13,
              cursor: advancing ? "not-allowed" : "pointer",
            }}
          >
            {hasBlockers ? "Close" : "Cancel"}
          </button>
          {!hasBlockers && (
            <button
              type="button"
              onClick={handleAdvance}
              disabled={advancing}
              style={{
                padding: "9px 18px",
                background: advancing ? "var(--accent)" : "var(--accent)",
                color: "var(--bg-panel)",
                border: "none",
                borderRadius: 6,
                fontWeight: 700,
                fontSize: 13,
                cursor: advancing ? "not-allowed" : "pointer",
              }}
            >
              {advancing
                ? "Advancing…"
                : hasWarnings
                  ? "Advance anyway"
                  : `Advance to ${formatStage(nextStage)}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function groupBySeverity(
  findings: db.FindingRow[]
): Array<{ severity: db.FindingRow["severity"]; rows: db.FindingRow[] }> {
  const map = new Map<db.FindingRow["severity"], db.FindingRow[]>();
  for (const f of findings) {
    const arr = map.get(f.severity) ?? [];
    arr.push(f);
    map.set(f.severity, arr);
  }
  return SEVERITY_ORDER.filter((s) => map.has(s)).map((s) => ({
    severity: s,
    rows: map.get(s) ?? [],
  }));
}

function FindingGroup({
  heading,
  groups,
  openErrors,
  onOpenFile,
}: {
  heading: string;
  groups: Array<{ severity: db.FindingRow["severity"]; rows: db.FindingRow[] }>;
  openErrors: Record<string, string>;
  onOpenFile: (f: db.FindingRow) => void;
}) {
  if (groups.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: "var(--text-tertiary)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {heading}
      </div>
      {groups.flatMap((g) =>
        g.rows.map((f) => (
          <FindingRow
            key={f.id}
            finding={f}
            openError={openErrors[f.id]}
            onOpenFile={() => onOpenFile(f)}
          />
        ))
      )}
    </div>
  );
}

function FindingRow({
  finding,
  openError,
  onOpenFile,
}: {
  finding: db.FindingRow;
  openError?: string;
  onOpenFile: () => void;
}) {
  const palette = SEVERITY_COLORS[finding.severity];
  return (
    <div
      style={{
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: 8,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: "uppercase",
            color: palette.text,
            background: "rgba(255,255,255,0.7)",
            border: `1px solid ${palette.border}`,
            padding: "2px 6px",
            borderRadius: 4,
            flexShrink: 0,
            marginTop: 1,
          }}
        >
          {palette.label}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: palette.text }}>{finding.title}</div>
          <div
            style={{
              fontSize: 12,
              color: "var(--text-secondary)",
              marginTop: 2,
              lineHeight: 1.45,
            }}
          >
            {finding.message}
          </div>
        </div>
      </div>
      {(finding.filePath || openError) && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {finding.filePath && (
            <>
              <span
                style={{
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 11,
                  color: "var(--text-secondary)",
                  background: "rgba(255,255,255,0.65)",
                  border: `1px solid ${palette.border}`,
                  padding: "2px 6px",
                  borderRadius: 4,
                  wordBreak: "break-all",
                }}
                title={finding.filePath}
              >
                📄 {finding.filePath}
              </span>
              <button
                type="button"
                onClick={onOpenFile}
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  background: "var(--bg-panel)",
                  color: "var(--accent)",
                  border: "1px solid var(--accent-soft)",
                  borderRadius: 4,
                  padding: "3px 10px",
                  cursor: "pointer",
                }}
              >
                Fix →
              </button>
            </>
          )}
          {openError && (
            <span style={{ fontSize: 11, color: "var(--danger)" }}>Couldn't open: {openError}</span>
          )}
        </div>
      )}
    </div>
  );
}
