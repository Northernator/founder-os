/**
 * DreamVaultProjectPage -- per-venture vault surface.
 *
 * Spec §3 slice 10 route: /dream-vault/projects/:slug. Shows the
 * sources + drafts routed to a single venture (during reviews + after
 * commits), grouped by note type. Until slice 12 lands the on-disk
 * walker, this surface is fed entirely from the in-memory pending +
 * recent vault import maps.
 */
import type { Venture } from "@founder-os/domain";
import type { ExtractedItem, ProjectMatch, SourceDocument } from "@founder-os/vault-contract";
import type { VaultNoteDraft, VaultSourceProcessing } from "@founder-os/vault-runner";
import { useMemo } from "react";
import type { PendingVaultImport, RecentVaultImport } from "../types.js";

export type DreamVaultProjectPageProps = {
  venture: Venture | null;
  /** Pass null + slug==="__unsorted__" to render the unsorted bucket. */
  slug: string;
  pending: ReadonlyMap<string, PendingVaultImport>;
  recent: ReadonlyArray<RecentVaultImport>;
  onOpenSource: (sourceId: string, fromJobId: string) => void;
  onOpenNote: (noteId: string, fromJobId: string) => void;
  onBack: () => void;
};

type ProjectRow = {
  source: SourceDocument;
  processing?: VaultSourceProcessing;
  matches: ProjectMatch[];
  items: ExtractedItem[];
  drafts: VaultNoteDraft[];
  fromJobId: string;
  /** "pending" while in needs_review; "committed" once finalize ran. */
  state: "pending" | "committed";
  committedPaths?: Record<string, string>;
};

export function DreamVaultProjectPage({
  venture,
  slug,
  pending,
  recent,
  onOpenSource,
  onOpenNote,
  onBack,
}: DreamVaultProjectPageProps) {
  const rows = useMemo<ProjectRow[]>(() => {
    const out: ProjectRow[] = [];
    const wantsUnsorted = slug === "__unsorted__" || venture === null;
    const ventureId = venture?.id ?? null;

    for (const entry of pending.values()) {
      const { run } = entry.result;
      for (const proc of run.perSource) {
        const matches = run.matches[proc.source.id] ?? [];
        const top = pickTopMatch(matches);
        const matchedHere =
          wantsUnsorted
            ? top === null || top.projectId === null
            : top !== null && top.projectId === ventureId;
        if (!matchedHere) continue;
        out.push({
          source: proc.source,
          processing: proc,
          matches,
          items: run.items[proc.source.id] ?? [],
          drafts: (run.drafts ?? []).filter((d) => d.sourceDocumentId === proc.source.id),
          fromJobId: entry.jobId,
          state: "pending",
        });
      }
    }

    for (const entry of recent) {
      const { run } = entry.pending.result;
      const notesBySource = new Map<string, RecentVaultImport["notesWritten"]>();
      for (const note of entry.notesWritten) {
        const arr = notesBySource.get(note.sourceDocumentId) ?? [];
        arr.push(note);
        notesBySource.set(note.sourceDocumentId, arr);
      }
      for (const proc of run.perSource) {
        const writtenForSource = notesBySource.get(proc.source.id) ?? [];
        const matchesHere = wantsUnsorted
          ? writtenForSource.some((n) => n.ventureSlug === null)
          : writtenForSource.some((n) => n.ventureSlug === slug);
        if (!matchesHere) continue;
        const matches = run.matches[proc.source.id] ?? [];
        const committedPaths: Record<string, string> = {};
        for (const n of writtenForSource) committedPaths[n.noteId] = n.absolutePath;
        out.push({
          source: proc.source,
          processing: proc,
          matches,
          items: run.items[proc.source.id] ?? [],
          drafts: (run.drafts ?? []).filter((d) => d.sourceDocumentId === proc.source.id),
          fromJobId: entry.jobId,
          state: "committed",
          committedPaths,
        });
      }
    }

    return out;
  }, [pending, recent, slug, venture]);

  const draftsByType = useMemo(() => {
    const map = new Map<string, Array<{ draft: VaultNoteDraft; fromJobId: string; committed?: string }>>();
    for (const row of rows) {
      for (const d of row.drafts) {
        const arr = map.get(d.noteType) ?? [];
        const entry: { draft: VaultNoteDraft; fromJobId: string; committed?: string } = {
          draft: d,
          fromJobId: row.fromJobId,
        };
        const committedPath = row.committedPaths?.[d.noteId];
        if (committedPath !== undefined) entry.committed = committedPath;
        arr.push(entry);
        map.set(d.noteType, arr);
      }
    }
    return map;
  }, [rows]);

  const displayName = slug === "__unsorted__" || venture === null ? "Unsorted" : venture.name;

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <button type="button" onClick={onBack} style={ghostBtn}>
          ← Back to vault
        </button>
        <span style={{ fontSize: 11, color: "var(--text-tertiary, #6B7280)" }}>
          {rows.length} source{rows.length === 1 ? "" : "s"} ·{" "}
          {[...draftsByType.values()].reduce((acc, arr) => acc + arr.length, 0)} draft notes
        </span>
      </div>
      <header>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>{displayName}</h2>
        {venture?.slug && (
          <code style={{ fontSize: 12, color: "var(--text-tertiary, #6B7280)" }}>{venture.slug}</code>
        )}
      </header>

      {rows.length === 0 ? (
        <p style={emptyHint}>
          Nothing routed here yet. Import sources and approve them on this venture in the review
          screen.
        </p>
      ) : (
        <>
          <section>
            <h4 style={subHead}>Sources</h4>
            <ul style={listStyle}>
              {rows.map((row) => (
                <li key={`${row.fromJobId}:${row.source.id}`} style={listItem}>
                  <button
                    type="button"
                    onClick={() => onOpenSource(row.source.id, row.fromJobId)}
                    style={linkBtn}
                  >
                    <strong style={{ fontSize: 12 }}>{row.source.originalName}</strong>
                  </button>{" "}
                  <span style={{ fontSize: 11, color: "var(--text-tertiary, #6B7280)" }}>
                    · {row.source.sourceType}
                    {row.source.confidence ? ` · ${row.source.confidence}` : ""}
                    {" · "}
                    {row.state === "committed" ? "committed" : "pending review"}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          {[...draftsByType.entries()].map(([noteType, drafts]) => (
            <section key={noteType}>
              <h4 style={subHead}>
                {prettyNoteType(noteType)} ({drafts.length})
              </h4>
              <ul style={listStyle}>
                {drafts.map(({ draft, fromJobId, committed }) => (
                  <li key={`${fromJobId}:${draft.noteId}`} style={listItem}>
                    <button
                      type="button"
                      onClick={() => onOpenNote(draft.noteId, fromJobId)}
                      style={linkBtn}
                    >
                      <strong style={{ fontSize: 12 }}>{draft.title}</strong>
                    </button>
                    {committed && (
                      <div
                        style={{
                          fontFamily: "ui-monospace, monospace",
                          fontSize: 10,
                          color: "var(--text-tertiary, #6B7280)",
                          wordBreak: "break-all",
                          marginTop: 2,
                        }}
                      >
                        {committed}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </section>
  );
}

function pickTopMatch(matches: ProjectMatch[]): ProjectMatch | null {
  if (matches.length === 0) return null;
  const order = { high: 0, medium: 1, low: 2 } as const;
  return [...matches].sort((a, b) => order[a.confidence] - order[b.confidence])[0] ?? null;
}

function prettyNoteType(t: string): string {
  return t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

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
  padding: "8px 10px",
  fontSize: 12,
  background: "var(--bg-muted, #F9FAFB)",
  border: "1px solid var(--border-subtle, #E5E7EB)",
  borderRadius: 8,
  marginBottom: 6,
};

const emptyHint: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: "var(--text-tertiary, #6B7280)",
};

const ghostBtn: React.CSSProperties = {
  padding: "4px 10px",
  background: "transparent",
  border: "1px solid var(--border-subtle, #E5E7EB)",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
};

const linkBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  padding: 0,
  cursor: "pointer",
  color: "var(--accent, #4F46E5)",
  textDecoration: "underline",
  fontSize: 12,
  fontWeight: 700,
};
