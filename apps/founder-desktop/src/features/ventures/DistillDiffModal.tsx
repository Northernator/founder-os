/**
 * Per-field diff modal for the "Distill from chat" flow.
 *
 * Field-agnostic: callers pass an ordered array of `DistillFieldConfig`
 * (key, label, render, equals) along with `current` / `proposed` objects
 * keyed by the same field names. Only fields where `proposed[key]` is
 * defined AND differs from `current[key]` are listed. The user accepts
 * a subset and the parent applies them via its own canvas-update path.
 *
 * If everything matches, the modal renders an "all up to date" panel —
 * the parent should still mount it so the user gets feedback after a
 * successful but no-op distill.
 */

import type React from "react";
import { useMemo, useState } from "react";

export type DistillFieldConfig = {
  key: string;
  label: string;
  /** Render either current or proposed value into the diff column. */
  render: (value: unknown) => React.ReactNode;
  /** Hide the row when current and proposed are equivalent. */
  equals: (current: unknown, proposed: unknown) => boolean;
};

export function distillRenderText(value: unknown): React.ReactNode {
  if (typeof value !== "string" || value.trim().length === 0) {
    return <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>(empty)</span>;
  }
  return <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{value}</span>;
}

export function distillTextEquals(current: unknown, proposed: unknown): boolean {
  const a = typeof current === "string" ? current : "";
  const b = typeof proposed === "string" ? proposed : "";
  return a.trim() === b.trim();
}

export function distillTextField(key: string, label: string): DistillFieldConfig {
  return { key, label, render: distillRenderText, equals: distillTextEquals };
}

export function DistillDiffModal({
  current,
  proposed,
  fields,
  onApply,
  onClose,
}: {
  current: Record<string, unknown>;
  proposed: Record<string, unknown>;
  fields: DistillFieldConfig[];
  onApply: (selected: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const changedFields = useMemo<DistillFieldConfig[]>(() => {
    return fields.filter((f) => {
      if (proposed[f.key] === undefined) return false;
      return !f.equals(current[f.key], proposed[f.key]);
    });
  }, [current, proposed, fields]);

  const [accepted, setAccepted] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const f of changedFields) init[f.key] = true;
    return init;
  });

  const acceptedCount = changedFields.filter((f) => accepted[f.key]).length;

  const setAll = (value: boolean) => {
    setAccepted((prev) => {
      const next = { ...prev };
      for (const f of changedFields) next[f.key] = value;
      return next;
    });
  };

  const handleApply = () => {
    const selected: Record<string, unknown> = {};
    for (const f of changedFields) {
      if (!accepted[f.key]) continue;
      const v = proposed[f.key];
      if (v !== undefined) selected[f.key] = v;
    }
    onApply(selected);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: role chosen intentionally; refactor deferred
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="distill-diff-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(17, 24, 39, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1100,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: "var(--bg-panel)",
          width: 920,
          maxWidth: "calc(100vw - 48px)",
          maxHeight: "calc(100vh - 80px)",
          borderRadius: 12,
          boxShadow: "0 20px 60px rgba(17, 24, 39, 0.3)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "18px 22px 12px",
            borderBottom: "1px solid var(--bg-hover)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <div>
            <h3
              id="distill-diff-title"
              style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "var(--text-primary)" }}
            >
              Review distilled fields
            </h3>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-tertiary)" }}>
              {changedFields.length === 0
                ? "Your canvas is already in sync with the chat — nothing to apply."
                : `AI extracted ${changedFields.length} field${
                    changedFields.length === 1 ? "" : "s"
                  } from your chat. Pick what to keep.`}
            </p>
          </div>
          {changedFields.length > 0 && (
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexShrink: 0 }}>
              <button
                type="button"
                onClick={() => setAll(true)}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--accent-hover)",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 600,
                  padding: 0,
                }}
              >
                Accept all
              </button>
              <span style={{ color: "var(--border-input)" }}>·</span>
              <button
                type="button"
                onClick={() => setAll(false)}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-tertiary)",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 600,
                  padding: 0,
                }}
              >
                Skip all
              </button>
            </div>
          )}
        </div>

        {/* Body */}
        <div
          style={{
            padding: "12px 22px 16px",
            overflow: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 14,
            flex: 1,
          }}
        >
          {changedFields.length === 0 ? (
            <div
              style={{
                padding: 28,
                textAlign: "center",
                color: "var(--text-tertiary)",
                fontSize: 13,
                background: "var(--bg-elevated)",
                borderRadius: 8,
              }}
            >
              No new information surfaced from the chat. Your fields are already up to date.
            </div>
          ) : (
            changedFields.map((f) => (
              <FieldDiffRow
                key={f.key}
                field={f}
                currentValue={current[f.key]}
                proposedValue={proposed[f.key]}
                accepted={accepted[f.key] ?? false}
                onToggle={(next) => setAccepted((prev) => ({ ...prev, [f.key]: next }))}
              />
            ))
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "12px 22px",
            borderTop: "1px solid var(--bg-hover)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
            background: "var(--bg-elevated)",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "8px 14px",
              background: "var(--bg-panel)",
              color: "var(--text-secondary)",
              border: "1px solid var(--border-input)",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={acceptedCount === 0}
            style={{
              padding: "8px 16px",
              background: acceptedCount === 0 ? "var(--border-subtle)" : "var(--accent)",
              color: acceptedCount === 0 ? "var(--text-muted)" : "var(--bg-panel)",
              border: "none",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 700,
              cursor: acceptedCount === 0 ? "not-allowed" : "pointer",
            }}
          >
            {acceptedCount === 0
              ? "Apply 0 changes"
              : `Apply ${acceptedCount} change${acceptedCount === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function FieldDiffRow({
  field,
  currentValue,
  proposedValue,
  accepted,
  onToggle,
}: {
  field: DistillFieldConfig;
  currentValue: unknown;
  proposedValue: unknown;
  accepted: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <div
      style={{
        border: `1px solid ${accepted ? "var(--accent-soft)" : "var(--border-subtle)"}`,
        background: accepted ? "var(--bg-elevated)" : "var(--bg-panel)",
        borderRadius: 8,
        padding: "12px 14px",
        transition: "background 0.15s, border-color 0.15s",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>
          {field.label}
        </div>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: "var(--text-secondary)",
            cursor: "pointer",
            userSelect: "none",
          }}
        >
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => onToggle(e.target.checked)}
            style={{ cursor: "pointer" }}
          />
          Accept
        </label>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
          alignItems: "start",
        }}
      >
        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: 0.5,
              marginBottom: 4,
            }}
          >
            Current
          </div>
          <div
            style={{
              fontSize: 13,
              color: "var(--text-secondary)",
              background: "var(--bg-elevated)",
              padding: 10,
              borderRadius: 6,
              minHeight: 40,
              lineHeight: 1.5,
            }}
          >
            {field.render(currentValue)}
          </div>
        </div>
        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--accent-hover)",
              textTransform: "uppercase",
              letterSpacing: 0.5,
              marginBottom: 4,
            }}
          >
            Proposed draft
          </div>
          <div
            style={{
              fontSize: 13,
              color: "var(--text-primary)",
              background: "var(--bg-panel)",
              border: "1px solid var(--border-subtle)",
              padding: 10,
              borderRadius: 6,
              minHeight: 40,
              lineHeight: 1.5,
            }}
          >
            {field.render(proposedValue)}
          </div>
        </div>
      </div>
    </div>
  );
}
