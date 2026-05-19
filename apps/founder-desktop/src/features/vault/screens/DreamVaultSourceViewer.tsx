/**
 * DreamVaultSourceViewer -- single source-document detail screen.
 *
 * Spec §3 slice 10 route: /dream-vault/sources/:id. Shows the
 * extracted markdown alongside the classifier's project matches +
 * extracted items + draft notes. Until slice 12 wires the Rust IPC
 * for committed sources, this surface only handles in-memory entries
 * (pending or just-committed).
 */
import type { ExtractedItem, ProjectMatch, SourceDocument } from "@founder-os/vault-contract";
import type { VaultNoteDraft, VaultSourceProcessing } from "@founder-os/vault-runner";

export type DreamVaultSourceViewerProps = {
  source: SourceDocument;
  processing?: VaultSourceProcessing;
  matches: ProjectMatch[];
  items: ExtractedItem[];
  drafts: VaultNoteDraft[];
  /** When the source has already been committed -- per-draft target path. */
  committedNotePaths?: Record<string, string>;
  onOpenNote: (noteId: string) => void;
  onBack: () => void;
};

export function DreamVaultSourceViewer({
  source,
  processing,
  matches,
  items,
  drafts,
  committedNotePaths,
  onOpenNote,
  onBack,
}: DreamVaultSourceViewerProps) {
  const markdown = processing?.markdown ?? "";
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <button type="button" onClick={onBack} style={ghostBtn}>
          ← Back
        </button>
        <span style={{ fontSize: 11, color: "var(--text-tertiary, #6B7280)" }}>
          Source · {source.sourceProvider}
        </span>
      </div>
      <header>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>{source.originalName}</h2>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-secondary, #4B5563)" }}>
          {source.sourceType}
          {source.fileExtension ? ` · .${source.fileExtension}` : ""}
          {source.confidence ? ` · ${source.confidence} confidence` : ""}
          {source.byteSize ? ` · ${formatBytes(source.byteSize)}` : ""}
        </p>
      </header>

      {processing?.summary && (
        <section>
          <h4 style={subHead}>Summary</h4>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>{processing.summary}</p>
        </section>
      )}

      <section>
        <h4 style={subHead}>Project matches</h4>
        {matches.length === 0 ? (
          <p style={emptyHint}>No project matches recorded for this source.</p>
        ) : (
          <ul style={listStyle}>
            {matches.map((m) => (
              <li key={m.id} style={listItem}>
                <strong style={{ fontSize: 12 }}>
                  {m.projectId ?? m.suggestedProjectName ?? "Unsorted"}
                </strong>{" "}
                <span style={{ fontSize: 11, color: "var(--text-tertiary, #6B7280)" }}>
                  · {m.confidence} · {m.status}
                </span>
                {m.reason && (
                  <div style={{ fontSize: 11, color: "var(--text-secondary, #4B5563)", marginTop: 2 }}>
                    {m.reason}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h4 style={subHead}>Drafts ({drafts.length})</h4>
        {drafts.length === 0 ? (
          <p style={emptyHint}>No drafts produced for this source.</p>
        ) : (
          <ul style={listStyle}>
            {drafts.map((d) => {
              const committedPath = committedNotePaths?.[d.noteId];
              return (
                <li key={d.noteId} style={listItem}>
                  <button
                    type="button"
                    onClick={() => onOpenNote(d.noteId)}
                    style={linkBtn}
                  >
                    <strong style={{ fontSize: 12 }}>{d.title}</strong>
                  </button>{" "}
                  <span style={{ fontSize: 11, color: "var(--text-tertiary, #6B7280)" }}>
                    ({d.noteType})
                  </span>
                  {committedPath && (
                    <div
                      style={{
                        fontFamily: "ui-monospace, monospace",
                        fontSize: 10,
                        color: "var(--text-tertiary, #6B7280)",
                        wordBreak: "break-all",
                        marginTop: 2,
                      }}
                    >
                      {committedPath}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <h4 style={subHead}>Extracted items ({items.length})</h4>
        {items.length === 0 ? (
          <p style={emptyHint}>No items extracted.</p>
        ) : (
          <ul style={listStyle}>
            {items.map((it) => (
              <li key={it.id} style={listItem}>
                <span style={typeBadge}>{it.type}</span>{" "}
                <strong style={{ fontSize: 12 }}>{it.title}</strong>
                <p
                  style={{
                    margin: "4px 0 0",
                    fontSize: 12,
                    color: "var(--text-secondary, #4B5563)",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {it.content}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h4 style={subHead}>Extracted markdown</h4>
        <pre
          style={{
            margin: 0,
            padding: "12px 14px",
            background: "var(--bg-muted, #F9FAFB)",
            border: "1px solid var(--border-subtle, #E5E7EB)",
            borderRadius: 10,
            fontSize: 12,
            lineHeight: 1.55,
            fontFamily: "ui-monospace, Menlo, monospace",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 320,
            overflowY: "auto",
          }}
        >
          {markdown || "(no extracted text available)"}
        </pre>
      </section>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
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

const typeBadge: React.CSSProperties = {
  display: "inline-block",
  padding: "1px 6px",
  fontSize: 10,
  fontWeight: 700,
  background: "var(--bg-surface, #FFFFFF)",
  border: "1px solid var(--border-subtle, #E5E7EB)",
  borderRadius: 4,
  marginRight: 6,
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
