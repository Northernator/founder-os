/**
 * DreamVaultBrowser -- the Dream Vault home + nested project / source / note views.
 *
 * The desktop has no react-router; mirroring VaultImportFlow's pattern,
 * this component hosts an internal screen state machine:
 *
 *   overview -> the home grid (sections + filters)
 *   project  -> /dream-vault/projects/:slug -- per-venture page
 *   source   -> /dream-vault/sources/:id    -- single source detail
 *   note     -> /dream-vault/notes/:id      -- single draft preview
 *
 * Slice 10 ships full screen surfaces, all fed from in-memory pending +
 * recent vault import maps the App holds. Slice 12 plumbs in on-disk
 * data once the Rust IPC for migration 0002-vault.sql lands.
 */
import type { Venture } from "@founder-os/domain";
import { useMemo, useState } from "react";
import { DreamVaultNoteViewer } from "./screens/DreamVaultNoteViewer.js";
import { DreamVaultOverview } from "./screens/DreamVaultOverview.js";
import { DreamVaultProjectPage } from "./screens/DreamVaultProjectPage.js";
import { DreamVaultSourceViewer } from "./screens/DreamVaultSourceViewer.js";
import type { PendingVaultImport, RecentVaultImport, RecoveredVaultImport } from "./types.js";

type BrowserScreen =
  | { kind: "overview" }
  | { kind: "project"; slug: string }
  | { kind: "source"; sourceId: string; fromJobId: string }
  | { kind: "note"; noteId: string; fromJobId: string };

export type DreamVaultBrowserProps = {
  ventures: Venture[];
  /** Rust IPC arc slice 5: the note viewer's Promote-to-venture button
   *  writes into this venture's `_imports-from-vault/` folder. */
  activeVenture?: Venture | null;
  pendingImports: ReadonlyMap<string, PendingVaultImport>;
  /** Rust IPC arc slice 4 -- jobs recovered from SQLite on boot. */
  recoveredImports?: ReadonlyMap<string, RecoveredVaultImport>;
  recentImports: ReadonlyArray<RecentVaultImport>;
  /** Opens the import wizard from inside the vault. */
  onStartImport: () => void;
  /** Opens the import flow's review screen for a specific pending job. */
  onReviewPending: (jobId: string) => void;
  /** Drops a pending entry from the App-level state. */
  onDiscardPending: (jobId: string) => void;
  /** Drops a recovered entry (Rust IPC slice 4). */
  onDiscardRecovered?: (jobId: string) => void;
  onClose: () => void;
};

export function DreamVaultBrowser({
  ventures,
  activeVenture,
  pendingImports,
  recoveredImports,
  recentImports,
  onStartImport,
  onReviewPending,
  onDiscardPending,
  onDiscardRecovered,
  onClose,
}: DreamVaultBrowserProps) {
  const [screen, setScreen] = useState<BrowserScreen>({ kind: "overview" });

  const ventureBySlug = useMemo(() => {
    const m = new Map<string, Venture>();
    for (const v of ventures) m.set(v.slug, v);
    return m;
  }, [ventures]);

  const handleOpenSource = (sourceId: string, fromJobId: string) => {
    setScreen({ kind: "source", sourceId, fromJobId });
  };
  const handleOpenNote = (noteId: string, fromJobId: string) => {
    setScreen({ kind: "note", noteId, fromJobId });
  };
  const handleOpenProject = (slug: string | "__unsorted__") => {
    setScreen({ kind: "project", slug });
  };
  const handleBack = () => setScreen({ kind: "overview" });

  return (
    <section
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: 32,
        gap: 18,
        overflowY: "auto",
      }}
    >
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>Dream Vault</h1>
        <button
          type="button"
          onClick={onClose}
          style={{
            padding: "6px 12px",
            background: "transparent",
            color: "var(--text-secondary, #4B5563)",
            border: "1px solid var(--border-subtle, #E5E7EB)",
            borderRadius: 8,
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Close
        </button>
      </header>

      {screen.kind === "overview" && (
        <DreamVaultOverview
          ventures={ventures}
          pending={pendingImports}
          {...(recoveredImports ? { recovered: recoveredImports } : {})}
          recent={recentImports}
          onReviewPending={onReviewPending}
          onDiscardPending={onDiscardPending}
          {...(onDiscardRecovered ? { onDiscardRecovered } : {})}
          onOpenProject={handleOpenProject}
          onOpenSource={handleOpenSource}
          onOpenNote={handleOpenNote}
          onStartImport={onStartImport}
        />
      )}

      {screen.kind === "project" && (
        <DreamVaultProjectPage
          venture={ventureBySlug.get(screen.slug) ?? null}
          slug={screen.slug}
          pending={pendingImports}
          recent={recentImports}
          onOpenSource={handleOpenSource}
          onOpenNote={handleOpenNote}
          onBack={handleBack}
        />
      )}

      {screen.kind === "source" && (() => {
        const detail = findSourceDetail(screen.sourceId, screen.fromJobId, pendingImports, recentImports);
        if (!detail) {
          return (
            <BackNotFound
              message="That source is no longer in memory — slice 12 wires on-disk lookups."
              onBack={handleBack}
            />
          );
        }
        const props: Parameters<typeof DreamVaultSourceViewer>[0] = {
          source: detail.source,
          matches: detail.matches,
          items: detail.items,
          drafts: detail.drafts,
          onOpenNote: (noteId) => handleOpenNote(noteId, screen.fromJobId),
          onBack: handleBack,
        };
        if (detail.processing) props.processing = detail.processing;
        if (detail.committedNotePaths) props.committedNotePaths = detail.committedNotePaths;
        return <DreamVaultSourceViewer {...props} />;
      })()}

      {screen.kind === "note" && (() => {
        const detail = findNoteDetail(screen.noteId, screen.fromJobId, pendingImports, recentImports);
        if (!detail) {
          return (
            <BackNotFound
              message="That note draft is no longer in memory — slice 12 wires on-disk lookups."
              onBack={handleBack}
            />
          );
        }
        const props: Parameters<typeof DreamVaultNoteViewer>[0] = {
          draft: detail.draft,
          onBack: handleBack,
        };
        if (detail.committedAbsolutePath !== undefined) props.committedAbsolutePath = detail.committedAbsolutePath;
        if (detail.committedRelativePath !== undefined) props.committedRelativePath = detail.committedRelativePath;
        if (activeVenture !== undefined) props.activeVenture = activeVenture;
        return <DreamVaultNoteViewer {...props} />;
      })()}
    </section>
  );
}

function BackNotFound({ message, onBack }: { message: string; onBack: () => void }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <button
        type="button"
        onClick={onBack}
        style={{
          alignSelf: "flex-start",
          padding: "4px 10px",
          background: "transparent",
          border: "1px solid var(--border-subtle, #E5E7EB)",
          borderRadius: 6,
          cursor: "pointer",
          fontSize: 12,
        }}
      >
        ← Back
      </button>
      <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary, #4B5563)" }}>{message}</p>
    </section>
  );
}

function findSourceDetail(
  sourceId: string,
  fromJobId: string,
  pending: ReadonlyMap<string, PendingVaultImport>,
  recent: ReadonlyArray<RecentVaultImport>
) {
  const pendingEntry = pending.get(fromJobId);
  const run = pendingEntry?.result.run ?? recent.find((r) => r.jobId === fromJobId)?.pending.result.run;
  if (!run) return null;
  const processing = run.perSource.find((p) => p.source.id === sourceId);
  if (!processing) return null;
  const matches = run.matches[sourceId] ?? [];
  const items = run.items[sourceId] ?? [];
  const drafts = (run.drafts ?? []).filter((d) => d.sourceDocumentId === sourceId);

  let committedNotePaths: Record<string, string> | undefined;
  const committedEntry = recent.find((r) => r.jobId === fromJobId);
  if (committedEntry) {
    committedNotePaths = {};
    for (const n of committedEntry.notesWritten) {
      if (n.sourceDocumentId === sourceId) committedNotePaths[n.noteId] = n.absolutePath;
    }
  }

  return {
    source: processing.source,
    processing,
    matches,
    items,
    drafts,
    committedNotePaths,
  };
}

function findNoteDetail(
  noteId: string,
  fromJobId: string,
  pending: ReadonlyMap<string, PendingVaultImport>,
  recent: ReadonlyArray<RecentVaultImport>
) {
  const pendingEntry = pending.get(fromJobId);
  const run = pendingEntry?.result.run ?? recent.find((r) => r.jobId === fromJobId)?.pending.result.run;
  if (!run) return null;
  const draft = run.drafts.find((d) => d.noteId === noteId);
  if (!draft) return null;

  const committedEntry = recent.find((r) => r.jobId === fromJobId);
  const committedNote = committedEntry?.notesWritten.find((n) => n.noteId === noteId);

  return {
    draft,
    committedAbsolutePath: committedNote?.absolutePath,
    committedRelativePath: committedNote?.relativePath,
  };
}
