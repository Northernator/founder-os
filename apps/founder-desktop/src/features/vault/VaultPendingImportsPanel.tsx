/**
 * VaultPendingImportsPanel
 *
 * Sister to features/ventures/PendingReviewsPanel -- same visual
 * pattern, different data source. The existing panel reads venture-
 * scoped review gates off disk; vault imports are workspace-scoped
 * and (slice 10) live in App-level memory only, so this panel takes
 * its `imports` prop directly rather than reading a file. Slice 12
 * will swap the in-memory map for a SQLite-backed source once the
 * migration 0002-vault.sql tables get IPC commands.
 *
 * Mounted on:
 *   - WelcomeScreen (when there are no ventures yet but the user
 *     already imported something)
 *   - DreamVaultBrowser overview
 *
 * Spec §1.7: "When an import reaches needs_review, surface it
 * through the same PendingReviewsPanel you ship for stage runs.
 * Don't build a parallel review UI. The review *content* (project
 * matches, extracted items) is vault-specific; the *gate row* is the
 * existing pattern." Hence: same visual pattern, vault-specific data
 * + actions.
 */
import type { PendingVaultImport, RecoveredVaultImport } from "./types.js";

export type VaultPendingImportsPanelProps = {
  imports: ReadonlyMap<string, PendingVaultImport>;
  /**
   * Rust IPC arc slice 4: jobs hydrated from SQLite on boot whose
   * runner state was lost on reload. Rendered alongside live entries
   * with a distinct "recovered" marker + a Discard-only action set.
   * Defaults to an empty map when the parent doesn't pass it (older
   * callers that haven't been updated for slice 4 keep working).
   */
  recovered?: ReadonlyMap<string, RecoveredVaultImport>;
  /** Opens the review screen for the given live (in-session) job. */
  onReview: (jobId: string) => void;
  /** Drops the live (in-session) pending entry from memory. */
  onDiscard: (jobId: string) => void;
  /** Drops a recovered (boot-hydrated) entry. Goes through
   *  vault_discard_job on the Rust side then clears local state. */
  onDiscardRecovered?: (jobId: string) => void;
};

export function VaultPendingImportsPanel({
  imports,
  recovered,
  onReview,
  onDiscard,
  onDiscardRecovered,
}: VaultPendingImportsPanelProps) {
  const liveRows = Array.from(imports.values()).sort((a, b) =>
    a.readyAt < b.readyAt ? 1 : -1
  );
  const recoveredRows = recovered
    ? Array.from(recovered.values()).sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : -1
      )
    : [];
  if (liveRows.length === 0 && recoveredRows.length === 0) return null;

  const total = liveRows.length + recoveredRows.length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 24 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 12,
          color: "var(--text-tertiary, #6B7280)",
        }}
      >
        <span style={{ fontWeight: 700 }}>Pending vault imports</span>
        <span>
          {total} awaiting{recoveredRows.length > 0 ? ` (${recoveredRows.length} recovered)` : ""}
        </span>
      </div>
      <div
        style={{
          border: "1px solid var(--border-subtle, #E5E7EB)",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        {liveRows.map((entry, idx) => (
          <PendingVaultImportRow
            key={entry.jobId}
            entry={entry}
            isLast={idx === liveRows.length - 1 && recoveredRows.length === 0}
            onReview={() => onReview(entry.jobId)}
            onDiscard={() => onDiscard(entry.jobId)}
          />
        ))}
        {recoveredRows.map((entry, idx) => (
          <RecoveredVaultImportRow
            key={entry.jobId}
            entry={entry}
            isLast={idx === recoveredRows.length - 1}
            onDiscard={() => onDiscardRecovered?.(entry.jobId)}
          />
        ))}
      </div>
    </div>
  );
}

function RecoveredVaultImportRow({
  entry,
  isLast,
  onDiscard,
}: {
  entry: RecoveredVaultImport;
  isLast: boolean;
  onDiscard: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "12px 14px",
        borderBottom: isLast ? "none" : "1px solid var(--border-subtle, #E5E7EB)",
        background: "var(--bg-muted, #F9FAFB)",
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
              color: "var(--text-secondary, #4B5563)",
            }}
          >
            {entry.jobId}
          </span>
          <span
            style={{
              padding: "2px 6px",
              borderRadius: 4,
              background: "var(--bg-surface, #FFFFFF)",
              border: "1px dashed var(--border-subtle, #E5E7EB)",
              color: "var(--text-tertiary, #6B7280)",
              fontSize: 11,
              fontWeight: 600,
            }}
            title="Recovered from a previous session — the runner state (drafts, matches, items) is gone, so this can only be discarded."
          >
            recovered
          </span>
          <span style={{ fontSize: 11, color: "var(--text-tertiary, #6B7280)" }}>
            created {new Date(entry.createdAt).toLocaleString()}
          </span>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-secondary, #4B5563)" }}>
          {entry.fileCount} source{entry.fileCount === 1 ? "" : "s"} · {entry.sourceProvider}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-tertiary, #6B7280)" }}>
          Drafts + matches from this job's review aren't persisted yet — discard and re-run to
          review.
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        <button
          type="button"
          onClick={onDiscard}
          style={{
            padding: "6px 12px",
            background: "transparent",
            color: "var(--text-secondary, #4B5563)",
            border: "1px solid var(--border-subtle, #E5E7EB)",
            borderRadius: 6,
            fontWeight: 600,
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Discard
        </button>
      </div>
    </div>
  );
}

function PendingVaultImportRow({
  entry,
  isLast,
  onReview,
  onDiscard,
}: {
  entry: PendingVaultImport;
  isLast: boolean;
  onReview: () => void;
  onDiscard: () => void;
}) {
  const { result, sources } = entry;
  const { run } = result;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "12px 14px",
        borderBottom: isLast ? "none" : "1px solid var(--border-subtle, #E5E7EB)",
        background: "var(--bg-surface, #FFFFFF)",
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
              color: "var(--text-secondary, #4B5563)",
            }}
          >
            {entry.jobId}
          </span>
          <span
            style={{
              padding: "2px 6px",
              borderRadius: 4,
              background: "color-mix(in srgb, var(--accent, #4F46E5) 14%, transparent)",
              color: "var(--accent, #4F46E5)",
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            vault review
          </span>
          {!entry.llmConfigured && (
            <span
              style={{
                padding: "2px 6px",
                borderRadius: 4,
                background: "var(--bg-muted, #F9FAFB)",
                color: "var(--text-tertiary, #6B7280)",
                fontSize: 11,
                fontWeight: 600,
                border: "1px dashed var(--border-subtle, #E5E7EB)",
              }}
              title="No LLM was wired; classifier + knowledge-extractor ran in deterministic fallback mode."
            >
              offline
            </span>
          )}
          <span style={{ fontSize: 11, color: "var(--text-tertiary, #6B7280)" }}>
            ready {new Date(entry.readyAt).toLocaleString()}
          </span>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-secondary, #4B5563)" }}>
          {sources.length} source{sources.length === 1 ? "" : "s"} ·{" "}
          {run.drafts.length} draft{run.drafts.length === 1 ? "" : "s"} ·{" "}
          {run.warnings.length} warning{run.warnings.length === 1 ? "" : "s"}
        </div>
        {sources.length > 0 && (
          <div
            style={{
              fontSize: 11,
              color: "var(--text-tertiary, #6B7280)",
              fontFamily: "ui-monospace, monospace",
              wordBreak: "break-all",
            }}
            title={sources.map((s) => s.originalName).join(", ")}
          >
            {sources
              .slice(0, 3)
              .map((s) => s.originalName)
              .join(", ")}
            {sources.length > 3 ? `, +${sources.length - 3} more` : ""}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        <button
          type="button"
          onClick={onDiscard}
          style={{
            padding: "6px 12px",
            background: "transparent",
            color: "var(--text-secondary, #4B5563)",
            border: "1px solid var(--border-subtle, #E5E7EB)",
            borderRadius: 6,
            fontWeight: 600,
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Discard
        </button>
        <button
          type="button"
          onClick={onReview}
          style={{
            padding: "6px 14px",
            background: "var(--accent, #4F46E5)",
            color: "var(--accent-fg, #FFFFFF)",
            border: "none",
            borderRadius: 6,
            fontWeight: 700,
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Review &amp; commit →
        </button>
      </div>
    </div>
  );
}
