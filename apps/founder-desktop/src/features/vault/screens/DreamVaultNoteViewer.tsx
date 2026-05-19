/**
 * DreamVaultNoteViewer -- single draft-note detail.
 *
 * Spec §3 slice 10 route: /dream-vault/notes/:id. Renders the
 * pre-rendered previewContent + frontmatter + the "promote to
 * venture" affordance. Slice 5 of the Rust IPC arc closes the
 * promote seam -- with vault_read_file_bytes wired + the desktop's
 * existing read_file / mkdir_p / write_file commands, a committed
 * note can be copied into the active venture's tree.
 */
import type { Venture } from "@founder-os/domain";
import type { VaultNoteDraft } from "@founder-os/vault-runner";
import { useState } from "react";
import { pushToast } from "../../../lib/toasts.js";
import { promoteNoteToVenture } from "../promote-to-venture.js";

export type DreamVaultNoteViewerProps = {
  draft: VaultNoteDraft;
  /** Set once the draft has been committed; renders the absolute path. */
  committedAbsolutePath?: string;
  committedRelativePath?: string;
  /** Rust IPC arc slice 5: when present + committedAbsolutePath is set,
   *  the "Promote to venture" button writes into the venture tree. */
  activeVenture?: Venture | null;
  onBack: () => void;
};

export function DreamVaultNoteViewer({
  draft,
  committedAbsolutePath,
  committedRelativePath,
  activeVenture,
  onBack,
}: DreamVaultNoteViewerProps) {
  const [promoting, setPromoting] = useState(false);
  const promoteEnabled =
    Boolean(committedAbsolutePath) && Boolean(activeVenture) && !promoting;

  const handlePromote = async () => {
    if (!committedAbsolutePath || !activeVenture) return;
    setPromoting(true);
    try {
      const res = await promoteNoteToVenture({
        sourceAbsolutePath: committedAbsolutePath,
        ventureRoot: activeVenture.rootPath,
        draft,
      });
      pushToast({
        kind: "success",
        message: `Promoted to ${activeVenture.name}`,
        detail: `Wrote ${res.relativePath}. Move it into a numbered folder when you're ready.`,
        ttlMs: 7000,
      });
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Promote to venture failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPromoting(false);
    }
  };

  const fm = draft.previewFrontmatter;
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <button type="button" onClick={onBack} style={ghostBtn}>
          ← Back
        </button>
        <button
          type="button"
          onClick={() => {
            if (!committedAbsolutePath) {
              pushToast({
                kind: "info",
                message: "Promote requires a committed note",
                detail:
                  "Commit the import to Dream Vault first, then return here to promote.",
                ttlMs: 5000,
              });
              return;
            }
            if (!activeVenture) {
              pushToast({
                kind: "info",
                message: "Pick an active venture first",
                detail:
                  "Promote writes into the active venture's _imports-from-vault folder.",
                ttlMs: 5000,
              });
              return;
            }
            void handlePromote();
          }}
          title={
            promoteEnabled
              ? `Copy into ${activeVenture?.name}/_imports-from-vault/`
              : "Commit the note + select an active venture to enable"
          }
          style={{
            ...ghostBtn,
            ...(promoteEnabled
              ? {}
              : {
                  borderStyle: "dashed",
                  color: "var(--text-tertiary, #6B7280)",
                  cursor: "not-allowed",
                }),
          }}
        >
          {promoting ? "Promoting…" : "Promote to venture"}
        </button>
      </div>

      <header>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>{draft.title}</h2>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-secondary, #4B5563)" }}>
          {draft.noteType}
          {fm.projectSlug ? ` · ${fm.projectSlug}` : " · unsorted"}
          {draft.confidence ? ` · ${draft.confidence} confidence` : ""}
        </p>
      </header>

      {(committedAbsolutePath || committedRelativePath) && (
        <section
          style={{
            padding: "10px 12px",
            background: "color-mix(in srgb, #10B981 8%, transparent)",
            border: "1px solid color-mix(in srgb, #10B981 24%, transparent)",
            borderRadius: 10,
            fontSize: 12,
          }}
        >
          <strong>Committed.</strong>
          <div
            style={{
              fontFamily: "ui-monospace, monospace",
              fontSize: 11,
              wordBreak: "break-all",
              marginTop: 4,
              color: "var(--text-secondary, #4B5563)",
            }}
          >
            {committedAbsolutePath ?? committedRelativePath}
          </div>
        </section>
      )}

      <section>
        <h4 style={subHead}>Frontmatter</h4>
        <pre style={code}>
          {[
            `title: ${fm.title}`,
            `sourceDocumentId: ${fm.sourceDocumentId}`,
            `projectSlug: ${fm.projectSlug ?? "(unsorted)"}`,
            `noteType: ${fm.noteType}`,
            fm.tags.length > 0 ? `tags: [${fm.tags.join(", ")}]` : "tags: []",
            fm.itemIds.length > 0 ? `itemIds: [${fm.itemIds.join(", ")}]` : "itemIds: []",
            fm.confidence ? `confidence: ${fm.confidence}` : null,
            `createdAt: ${fm.createdAt}`,
          ]
            .filter(Boolean)
            .join("\n")}
        </pre>
      </section>

      <section>
        <h4 style={subHead}>Content preview</h4>
        <pre
          style={{
            ...code,
            maxHeight: 360,
            overflowY: "auto",
          }}
        >
          {draft.previewContent}
        </pre>
      </section>
    </section>
  );
}

const subHead: React.CSSProperties = {
  margin: "0 0 6px",
  fontSize: 13,
  fontWeight: 700,
  color: "var(--text-secondary, #4B5563)",
};

const code: React.CSSProperties = {
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
};

const ghostBtn: React.CSSProperties = {
  padding: "4px 10px",
  background: "transparent",
  border: "1px solid var(--border-subtle, #E5E7EB)",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
};
