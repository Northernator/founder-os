/**
 * Toast container — renders the stack driven by useToastStore.
 *
 * Mount once at the app root (see App.tsx). Fixed-position, bottom-right,
 * stacks newest-on-top. Errors are sticky (require X dismiss), everything
 * else auto-dismisses via the store.
 *
 * Styling is inline to match the rest of the desktop app — we aren't using
 * Tailwind here. Colours pulled from the same palette used by AuditTab's
 * severity badges for visual consistency.
 */
import React from "react";
import { useToastStore, type Toast, type ToastKind } from "../../lib/toasts.js";

const KIND_STYLE: Record<
  ToastKind,
  { bg: string; border: string; fg: string; icon: string }
> = {
  info: { bg: "#EFF6FF", border: "#BFDBFE", fg: "#1E3A8A", icon: "ℹ" },
  success: { bg: "#ECFDF5", border: "#A7F3D0", fg: "#065F46", icon: "✓" },
  warn: { bg: "#FFFBEB", border: "#FDE68A", fg: "#92400E", icon: "⚠" },
  error: { bg: "#FEF2F2", border: "#FECACA", fg: "#991B1B", icon: "✕" },
};

export function ToastContainer() {
  // Subscribe via selector so we only re-render when the list changes —
  // not when unrelated zustand state changes (there's none today but good
  // hygiene for when the store grows).
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      role="region"
      aria-label="Notifications"
      style={{
        position: "fixed",
        bottom: 16,
        right: 16,
        display: "flex",
        flexDirection: "column-reverse",
        gap: 8,
        // High z-index so we sit above modals like the NewVentureWizard.
        // The wizard's backdrop uses no explicit z-index (just stacking
        // context), so 9999 is plenty.
        zIndex: 9999,
        maxWidth: 380,
        pointerEvents: "none",
      }}
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: () => void;
}) {
  const s = KIND_STYLE[toast.kind];
  return (
    <div
      role="alert"
      style={{
        background: s.bg,
        border: `1px solid ${s.border}`,
        borderRadius: 8,
        padding: "10px 12px",
        boxShadow: "0 6px 16px rgba(0, 0, 0, 0.08)",
        color: s.fg,
        fontSize: 13,
        lineHeight: 1.4,
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        // Re-enable pointer events on the card itself so the X is clickable.
        // The wrapper disables them so the toast stack doesn't eat clicks on
        // content behind it when toasts are far away from the cursor.
        pointerEvents: "auto",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          fontSize: 14,
          fontWeight: 700,
          lineHeight: 1.2,
          flex: "0 0 auto",
          marginTop: 1,
        }}
      >
        {s.icon}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, wordBreak: "break-word" }}>
          {toast.message}
        </div>
        {toast.detail && (
          <div
            style={{
              marginTop: 4,
              fontSize: 11,
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              opacity: 0.85,
              wordBreak: "break-word",
              whiteSpace: "pre-wrap",
            }}
          >
            {toast.detail}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        style={{
          background: "transparent",
          border: "none",
          color: s.fg,
          cursor: "pointer",
          fontSize: 14,
          lineHeight: 1,
          padding: 2,
          marginLeft: 2,
          opacity: 0.6,
          flex: "0 0 auto",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
        onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.6")}
      >
        ✕
      </button>
    </div>
  );
}
