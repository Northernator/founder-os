/**
 * VaultImportReviewScreen -- the post-progress review gate.
 *
 * Spec §3 slice 10 sections, mapped to this surface:
 *   - Suggested project groups -- grouped per-source list with the
 *     classifier's top ProjectMatch + a venture-slug picker per source.
 *   - Source documents -- one row per ingested source; reject/approve
 *     toggles + an inline view of the draft note + extracted items.
 *   - Extracted items -- nested under each source, with confidence and
 *     type badges.
 *   - Warnings -- aggregated at the top so the reviewer sees them first.
 *
 * Actions per source:
 *   - Approve (default)  -- stays included; routes to the picked slug.
 *   - Reject             -- skipped at finalize; nothing written.
 *   - Move to project    -- changes the venture-slug pick.
 *   - Send to unsorted   -- sets ventureSlug to null.
 *   - Create new venture from group -- slice 12, surfaced as disabled.
 *
 * Commit hits `pending.result.finalize({ approvals, now })` then
 * forwards to onCommitted.
 */
import type { Venture } from "@founder-os/domain";
import type { ExtractedItem, ProjectMatch } from "@founder-os/vault-contract";
import type { VaultNoteDraft, VaultSourceApproval } from "@founder-os/vault-runner";
import { useMemo, useState } from "react";
import { pushToast } from "../../../lib/toasts.js";
import type { PendingVaultImport, RecentVaultImport } from "../types.js";

type ApprovalDecision = "approved" | "rejected";

type SourceDecision = {
  decision: ApprovalDecision;
  ventureSlug: string | null;
  /** Note ids the reviewer wants written. Undefined = "all drafts for this source". */
  acceptedNoteIds?: string[];
};

const UNSORTED_SLUG: string | null = null;

export type VaultImportReviewScreenProps = {
  pending: PendingVaultImport;
  /** Ventures the reviewer can route sources to. */
  ventures: Venture[];
  /** Called after finalize() resolves -- App.tsx promotes the pending
   *  entry to recentVaultImports. */
  onCommitted: (recent: RecentVaultImport) => void;
  /** Cancel-and-keep-pending. The runner state stays valid for re-review. */
  onClose: () => void;
};

export function VaultImportReviewScreen({
  pending,
  ventures,
  onCommitted,
  onClose,
}: VaultImportReviewScreenProps) {
  const { result } = pending;
  const { run } = result;

  // Seed decisions from the runner's drafts/matches. By default every
  // source is approved and routed to the classifier's top suggestion
  // (or unsorted when there is none).
  const initialDecisions = useMemo<Record<string, SourceDecision>>(() => {
    const out: Record<string, SourceDecision> = {};
    for (const proc of run.perSource) {
      const topMatch = pickTopMatch(run.matches[proc.source.id] ?? []);
      const ventureSlug =
        topMatch && topMatch.projectId
          ? ventures.find((v) => v.id === topMatch.projectId)?.slug ?? UNSORTED_SLUG
          : UNSORTED_SLUG;
      out[proc.source.id] = {
        decision: proc.extraction.kind === "failed" ? "rejected" : "approved",
        ventureSlug,
      };
    }
    return out;
  }, [run.perSource, run.matches, ventures]);

  const [decisions, setDecisions] = useState<Record<string, SourceDecision>>(initialDecisions);
  const [committing, setCommitting] = useState(false);

  const draftsBySource = useMemo(() => groupDraftsBySource(run.drafts), [run.drafts]);
  const itemsBySource = run.items;

  const approvedCount = Object.values(decisions).filter((d) => d.decision === "approved").length;
  const rejectedCount = Object.values(decisions).filter((d) => d.decision === "rejected").length;

  const handleDecision = (sourceId: string, patch: Partial<SourceDecision>) => {
    setDecisions((prev) => ({
      ...prev,
      [sourceId]: { ...(prev[sourceId] ?? { decision: "approved", ventureSlug: null }), ...patch },
    }));
  };

  const handleCommit = async () => {
    if (committing) return;
    setCommitting(true);
    const approvals: VaultSourceApproval[] = Object.entries(decisions)
      .filter(([, d]) => d.decision === "approved")
      .map(([sourceDocumentId, d]) => ({
        sourceDocumentId,
        ventureSlug: d.ventureSlug,
        ...(d.acceptedNoteIds ? { acceptedNoteIds: d.acceptedNoteIds } : {}),
      }));
    try {
      const now = new Date().toISOString();
      const res = await result.finalize({ approvals, now });
      if (res.status === "failed") {
        pushToast({
          kind: "error",
          message: "Couldn't commit to Dream Vault",
          detail: res.error?.message ?? "Unknown error",
        });
        setCommitting(false);
        return;
      }
      pushToast({
        kind: "success",
        message: `Committed ${res.notesWritten.length} note${res.notesWritten.length === 1 ? "" : "s"} to Dream Vault`,
        detail:
          res.skippedCount > 0 ? `${res.skippedCount} draft(s) skipped per your decisions.` : undefined,
        ttlMs: 6000,
      });
      onCommitted({
        jobId: pending.jobId,
        pending,
        notesWritten: res.notesWritten,
        skippedCount: res.skippedCount,
        warnings: res.warnings,
        committedAt: now,
      });
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Vault commit threw an error",
        detail: err instanceof Error ? err.message : String(err),
      });
      setCommitting(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>Review Dream Vault imports</h3>
          <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--text-secondary, #4B5563)" }}>
            {run.perSource.length} source{run.perSource.length === 1 ? "" : "s"} processed ·{" "}
            {run.drafts.length} draft note{run.drafts.length === 1 ? "" : "s"} ready ·{" "}
            {approvedCount} approved, {rejectedCount} rejected
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={onClose} disabled={committing} style={secondaryBtn(committing)}>
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCommit}
            disabled={committing || approvedCount === 0}
            style={primaryBtn(committing || approvedCount === 0)}
          >
            {committing ? "Committing…" : "Commit to Dream Vault"}
          </button>
        </div>
      </header>

      {run.warnings.length > 0 && (
        <section>
          <h4 style={subHead}>Warnings ({run.warnings.length})</h4>
          <ul style={listStyle}>
            {run.warnings.slice(0, 30).map((w, idx) => (
              <li
                key={`${idx}-${w.slice(0, 16)}`}
                style={{ ...listItem, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 11 }}
              >
                {w}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h4 style={subHead}>Suggested project groups</h4>
        <ProjectGroupSummary
          run={run}
          decisions={decisions}
          ventures={ventures}
        />
      </section>

      <section>
        <h4 style={subHead}>Source documents</h4>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {run.perSource.map((proc) => {
            const decision = decisions[proc.source.id] ?? {
              decision: "approved" as ApprovalDecision,
              ventureSlug: null,
            };
            return (
              <SourceRow
                key={proc.source.id}
                processing={proc}
                drafts={draftsBySource[proc.source.id] ?? []}
                items={itemsBySource[proc.source.id] ?? []}
                matches={run.matches[proc.source.id] ?? []}
                ventures={ventures}
                decision={decision}
                onChange={(patch) => handleDecision(proc.source.id, patch)}
                disabled={committing}
              />
            );
          })}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

type RunResultShape = VaultImportReviewScreenProps["pending"]["result"]["run"];

function ProjectGroupSummary({
  run,
  decisions,
  ventures,
}: {
  run: RunResultShape;
  decisions: Record<string, SourceDecision>;
  ventures: Venture[];
}) {
  const groups = new Map<string | null, number>();
  for (const proc of run.perSource) {
    const decision = decisions[proc.source.id];
    if (!decision || decision.decision === "rejected") continue;
    const slug = decision.ventureSlug;
    groups.set(slug, (groups.get(slug) ?? 0) + 1);
  }
  if (groups.size === 0) {
    return (
      <p style={emptyHint}>
        Nothing routed yet — every source is rejected. Approve at least one to commit.
      </p>
    );
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: 10,
      }}
    >
      {Array.from(groups.entries()).map(([slug, count]) => {
        const venture = slug ? ventures.find((v) => v.slug === slug) : null;
        const label = slug === null ? "Unsorted" : venture?.name ?? slug;
        return (
          <div
            key={slug ?? "__unsorted__"}
            style={{
              padding: 12,
              borderRadius: 10,
              border: "1px solid var(--border-subtle, #E5E7EB)",
              background: "var(--bg-muted, #F9FAFB)",
            }}
          >
            <strong style={{ fontSize: 13, color: "var(--text-primary, #0F172A)" }}>{label}</strong>
            <div style={{ fontSize: 11, color: "var(--text-secondary, #4B5563)" }}>
              {count} source{count === 1 ? "" : "s"} routed here
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SourceRow({
  processing,
  drafts,
  items,
  matches,
  ventures,
  decision,
  onChange,
  disabled,
}: {
  processing: RunResultShape["perSource"][number];
  drafts: VaultNoteDraft[];
  items: ExtractedItem[];
  matches: ProjectMatch[];
  ventures: Venture[];
  decision: SourceDecision;
  onChange: (patch: Partial<SourceDecision>) => void;
  disabled: boolean;
}) {
  const { source, extraction } = processing;
  const failed = extraction.kind === "failed";
  const topMatch = pickTopMatch(matches);
  return (
    <article
      style={{
        border: "1px solid var(--border-subtle, #E5E7EB)",
        borderRadius: 12,
        background: failed ? "color-mix(in srgb, #B91C1C 6%, transparent)" : "var(--bg-surface, #FFFFFF)",
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        opacity: decision.decision === "rejected" ? 0.55 : 1,
      }}
    >
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontWeight: 700,
              fontSize: 14,
              color: "var(--text-primary, #0F172A)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={source.originalName}
          >
            {source.originalName}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-tertiary, #6B7280)" }}>
            {source.sourceType} · {source.sourceProvider}
            {source.confidence ? ` · ${source.confidence} confidence` : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            onClick={() => onChange({ decision: "approved" })}
            disabled={disabled || failed}
            style={pillBtn(decision.decision === "approved", disabled || failed)}
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => onChange({ decision: "rejected" })}
            disabled={disabled}
            style={pillBtn(decision.decision === "rejected", disabled, "danger")}
          >
            Reject
          </button>
        </div>
      </header>

      {failed && extraction.kind === "failed" && (
        <p style={{ margin: 0, fontSize: 12, color: "#B91C1C" }}>
          <strong>Extraction failed:</strong> {extraction.error}
        </p>
      )}

      {!failed && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary, #4B5563)" }}>
            Route to{" "}
            <select
              value={decision.ventureSlug ?? "__unsorted__"}
              onChange={(e) =>
                onChange({ ventureSlug: e.target.value === "__unsorted__" ? null : e.target.value })
              }
              disabled={disabled || decision.decision === "rejected"}
              style={{
                marginLeft: 6,
                padding: "4px 8px",
                fontSize: 12,
                border: "1px solid var(--border-subtle, #E5E7EB)",
                borderRadius: 6,
                background: "var(--bg-surface, #FFFFFF)",
              }}
            >
              <option value="__unsorted__">Unsorted (inbox)</option>
              {ventures.map((v) => (
                <option key={v.id} value={v.slug}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          {topMatch && topMatch.confidence && (
            <span
              style={{
                fontSize: 11,
                color: "var(--text-secondary, #4B5563)",
                padding: "2px 8px",
                borderRadius: 4,
                background: "var(--bg-muted, #F9FAFB)",
                border: "1px solid var(--border-subtle, #E5E7EB)",
              }}
            >
              Classifier suggested:{" "}
              {topMatch.projectId
                ? ventures.find((v) => v.id === topMatch.projectId)?.name ?? topMatch.suggestedProjectName ?? "unknown"
                : topMatch.suggestedProjectName ?? "unsorted"}{" "}
              ({topMatch.confidence})
            </span>
          )}
          {/* Create-new-venture seam -- enabled once slice 12 lands. */}
          <button
            type="button"
            disabled
            title="Promote group to a new venture — lands with the Rust IPC in slice 12"
            style={{
              padding: "4px 10px",
              fontSize: 11,
              background: "var(--bg-muted, #F9FAFB)",
              color: "var(--text-tertiary, #6B7280)",
              border: "1px dashed var(--border-subtle, #E5E7EB)",
              borderRadius: 6,
              cursor: "not-allowed",
            }}
          >
            + New venture from this group
          </button>
        </div>
      )}

      {processing.summary && (
        <p
          style={{
            margin: 0,
            fontSize: 12,
            color: "var(--text-secondary, #4B5563)",
            lineHeight: 1.5,
          }}
        >
          {processing.summary}
        </p>
      )}

      {drafts.length > 0 && (
        <details>
          <summary style={summaryStyle}>
            {drafts.length} draft note{drafts.length === 1 ? "" : "s"}
          </summary>
          <ul style={{ ...listStyle, marginTop: 6 }}>
            {drafts.map((d) => (
              <li key={d.noteId} style={listItem}>
                <strong style={{ fontSize: 12 }}>{d.title}</strong>{" "}
                <span style={{ fontSize: 11, color: "var(--text-tertiary, #6B7280)" }}>
                  ({d.noteType})
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {items.length > 0 && (
        <details>
          <summary style={summaryStyle}>
            {items.length} extracted item{items.length === 1 ? "" : "s"}
          </summary>
          <ul style={{ ...listStyle, marginTop: 6 }}>
            {items.slice(0, 50).map((it) => (
              <li key={it.id} style={listItem}>
                <span
                  style={{
                    display: "inline-block",
                    padding: "1px 6px",
                    fontSize: 10,
                    fontWeight: 700,
                    background: "var(--bg-muted, #F9FAFB)",
                    border: "1px solid var(--border-subtle, #E5E7EB)",
                    borderRadius: 4,
                    marginRight: 6,
                  }}
                >
                  {it.type}
                </span>
                <strong style={{ fontSize: 12 }}>{it.title}</strong>{" "}
                <span style={{ fontSize: 11, color: "var(--text-tertiary, #6B7280)" }}>
                  · {it.confidence}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickTopMatch(matches: ProjectMatch[]): ProjectMatch | null {
  if (matches.length === 0) return null;
  const order = { high: 0, medium: 1, low: 2 } as const;
  return [...matches].sort((a, b) => order[a.confidence] - order[b.confidence])[0] ?? null;
}

function groupDraftsBySource(drafts: VaultNoteDraft[]): Record<string, VaultNoteDraft[]> {
  const out: Record<string, VaultNoteDraft[]> = {};
  for (const d of drafts) {
    const arr = out[d.sourceDocumentId] ?? [];
    arr.push(d);
    out[d.sourceDocumentId] = arr;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const subHead: React.CSSProperties = {
  margin: "0 0 6px",
  fontSize: 13,
  fontWeight: 700,
  color: "var(--text-secondary, #4B5563)",
};

const listStyle: React.CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const listItem: React.CSSProperties = {
  padding: "6px 10px",
  fontSize: 12,
  background: "var(--bg-muted, #F9FAFB)",
  border: "1px solid var(--border-subtle, #E5E7EB)",
  borderRadius: 8,
  marginBottom: 4,
};

const summaryStyle: React.CSSProperties = {
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 700,
  color: "var(--text-secondary, #4B5563)",
};

const emptyHint: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: "var(--text-tertiary, #6B7280)",
};

function primaryBtn(disabled: boolean): React.CSSProperties {
  return {
    padding: "8px 14px",
    background: disabled ? "var(--bg-muted, #F9FAFB)" : "var(--accent, #4F46E5)",
    color: disabled ? "var(--text-tertiary, #6B7280)" : "var(--accent-fg, #FFFFFF)",
    border: "1px solid transparent",
    borderRadius: 8,
    fontWeight: 700,
    fontSize: 13,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function secondaryBtn(disabled: boolean): React.CSSProperties {
  return {
    padding: "8px 14px",
    background: "transparent",
    color: "var(--text-secondary, #4B5563)",
    border: "1px solid var(--border-subtle, #E5E7EB)",
    borderRadius: 8,
    fontWeight: 600,
    fontSize: 13,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function pillBtn(active: boolean, disabled: boolean, tone: "default" | "danger" = "default"): React.CSSProperties {
  const dangerActive = tone === "danger" && active;
  return {
    padding: "5px 10px",
    fontSize: 12,
    fontWeight: 700,
    borderRadius: 999,
    border: "1px solid var(--border-subtle, #E5E7EB)",
    background: dangerActive
      ? "#B91C1C"
      : active
        ? "var(--accent, #4F46E5)"
        : "var(--bg-surface, #FFFFFF)",
    color: dangerActive || active ? "var(--accent-fg, #FFFFFF)" : "var(--text-secondary, #4B5563)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.6 : 1,
  };
}
