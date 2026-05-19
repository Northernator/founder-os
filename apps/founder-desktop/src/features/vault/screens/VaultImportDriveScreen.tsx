/**
 * VaultImportDriveScreen -- the Google Drive picker UI (spec §3 slice 11).
 *
 * Sections (top-to-bottom):
 *   - Connect card with OAuth button. Calls gdrive_start_oauth ->
 *     opens the consent URL in the system browser via @tauri-apps/
 *     plugin-shell -> awaits gdrive_complete_oauth on the loopback.
 *   - Account email + status + Disconnect button.
 *   - Search input + recent files list.
 *   - Folder breadcrumb + folder browser.
 *   - Staging area (multi-select) + Start Import button.
 *
 * Privacy copy is non-optional per spec §3 slice 11: "DreamLauncher
 * copies the files you select. Drive files are never modified.
 * Nothing is published."
 *
 * The renderer never sees an OAuth token -- all Rust commands work
 * against the SQLite vault_cloud_connections row keyed by
 * accountEmail; the token lives in the OS keychain via the `keyring`
 * crate. Slice 12 wires the Rust side; until then, every Drive call
 * throws DriveCommandNotWiredError which this screen catches + shows
 * as a "Drive IPC pending" banner.
 */
import {
  type DriveConnection,
  type DriveFile,
  driveFileToSourceType,
} from "@founder-os/google-drive-importer";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { useCallback, useEffect, useMemo, useState } from "react";
import { pushToast } from "../../../lib/toasts.js";
import { buildDriveClient, DriveCommandNotWiredError } from "../drive-client.js";
import type { VaultImportSourceInput } from "../run-vault-import.js";
import { PrivacyBanner } from "./VaultImportHubScreen.js";

export type VaultImportDriveScreenProps = {
  onBack: () => void;
  /** Same start-import callback the local-file screen uses, with
   *  provider hard-coded to "google_drive" by the runner caller. */
  onStartImport: (sources: VaultImportSourceInput[], jobId: string) => void;
};

type BrowseLevel = { folderId: string; name: string };

function nextJobId(): string {
  return `vimp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Map a Drive file row onto the staging-source contract the runner consumes. */
function driveFileToSourceInput(file: DriveFile): VaultImportSourceInput {
  // The absolutePath is a synthetic Drive marker -- the runner picks
  // this up + calls gdrive_download_file / gdrive_export_doc before
  // running the extractor port. Slice 12 swaps this for the real
  // post-download absolute path.
  const synthetic: VaultImportSourceInput = {
    absolutePath: `__drive__/${file.id}`,
    originalName: file.name,
    sourceType: driveFileToSourceType({ mimeType: file.mimeType, originalName: file.name }),
    mimeType: file.mimeType,
  };
  if (file.size !== undefined) synthetic.byteSize = file.size;
  const ext = file.name.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase();
  if (ext) synthetic.fileExtension = ext;
  return synthetic;
}

export function VaultImportDriveScreen({ onBack, onStartImport }: VaultImportDriveScreenProps) {
  const driveClient = useMemo(() => buildDriveClient(), []);

  const [connection, setConnection] = useState<DriveConnection | null>(null);
  const [connectionState, setConnectionState] = useState<"loading" | "ready" | "ipc-pending">("loading");
  const [connecting, setConnecting] = useState(false);

  const [browseStack, setBrowseStack] = useState<BrowseLevel[]>([{ folderId: "__recent__", name: "Recent files" }]);
  const [rows, setRows] = useState<DriveFile[]>([]);
  const [loadingRows, setLoadingRows] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState("");
  const [searchActive, setSearchActive] = useState(false);

  const [staged, setStaged] = useState<DriveFile[]>([]);

  // Initial: try to hydrate any existing connection.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const conn = await driveClient.getConnection();
        if (cancelled) return;
        setConnection(conn);
        setConnectionState("ready");
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DriveCommandNotWiredError) {
          setConnectionState("ipc-pending");
        } else {
          setError(err instanceof Error ? err.message : String(err));
          setConnectionState("ready");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [driveClient]);

  const loadRowsForCurrentLevel = useCallback(async () => {
    if (!connection) return;
    setLoadingRows(true);
    setError(null);
    try {
      const top = browseStack[browseStack.length - 1];
      if (!top) return;
      let next: DriveFile[];
      if (top.folderId === "__recent__") {
        next = await driveClient.listRecent(connection.id);
      } else {
        next = await driveClient.listFolder(connection.id, top.folderId);
      }
      setRows(next);
      setSearchActive(false);
    } catch (err) {
      if (err instanceof DriveCommandNotWiredError) {
        setConnectionState("ipc-pending");
        setRows([]);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setLoadingRows(false);
    }
  }, [browseStack, connection, driveClient]);

  // Auto-load rows when connected or when the user navigates folders.
  useEffect(() => {
    if (connection) void loadRowsForCurrentLevel();
  }, [connection, loadRowsForCurrentLevel]);

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  const handleConnect = async () => {
    if (connecting) return;
    setConnecting(true);
    setError(null);
    try {
      const start = await driveClient.startOAuth();
      try {
        await openExternal(start.consentUrl);
      } catch {
        // System-browser open can fail (no shell plugin in dev, e.g.) --
        // surface the URL so the user can paste it themselves.
        pushToast({
          kind: "info",
          message: "Couldn't auto-open the browser",
          detail: `Paste this URL to grant DreamLauncher Drive read-only access:\n${start.consentUrl}`,
          ttlMs: 12_000,
        });
      }
      const completed = await driveClient.completeOAuth(start.state);
      setConnection(completed.connection);
      pushToast({
        kind: "success",
        message: `Connected to Google Drive as ${completed.connection.accountEmail}`,
        ttlMs: 5000,
      });
    } catch (err) {
      if (err instanceof DriveCommandNotWiredError) {
        setConnectionState("ipc-pending");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!connection) return;
    try {
      await driveClient.disconnect(connection.id);
      pushToast({
        kind: "info",
        message: "Disconnected from Google Drive",
        detail: "Tokens cleared from the OS keychain.",
        ttlMs: 4000,
      });
      setConnection(null);
      setRows([]);
      setStaged([]);
      setBrowseStack([{ folderId: "__recent__", name: "Recent files" }]);
    } catch (err) {
      if (err instanceof DriveCommandNotWiredError) {
        setConnectionState("ipc-pending");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const handleSearch = async () => {
    if (!connection || searchInput.trim().length === 0) return;
    setLoadingRows(true);
    setError(null);
    try {
      const next = await driveClient.search(connection.id, searchInput.trim());
      setRows(next);
      setSearchActive(true);
    } catch (err) {
      if (err instanceof DriveCommandNotWiredError) {
        setConnectionState("ipc-pending");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setLoadingRows(false);
    }
  };

  const handleEnterFolder = (file: DriveFile) => {
    if (!file.isFolder) return;
    setBrowseStack((prev) => [...prev, { folderId: file.id, name: file.name }]);
  };

  const handleBreadcrumb = (level: number) => {
    setBrowseStack((prev) => prev.slice(0, level + 1));
  };

  const toggleStage = (file: DriveFile) => {
    if (file.isFolder) return;
    setStaged((prev) => {
      const exists = prev.find((s) => s.id === file.id);
      if (exists) return prev.filter((s) => s.id !== file.id);
      return [...prev, file];
    });
  };

  const handleStart = () => {
    if (staged.length === 0) return;
    const sources = staged.map(driveFileToSourceInput);
    onStartImport(sources, nextJobId());
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div>
      <PrivacyBanner />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Import from Google Drive</h3>
        <button type="button" onClick={onBack} style={ghostBtn}>
          ← Back
        </button>
      </div>

      <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--text-secondary, #4B5563)", lineHeight: 1.5 }}>
        DreamLauncher copies the files you select into your local Dream Vault. Drive files are
        never modified. Nothing is published. Access is read-only.
      </p>

      <ConnectCard
        connection={connection}
        connectionState={connectionState}
        connecting={connecting}
        onConnect={handleConnect}
        onDisconnect={handleDisconnect}
      />

      {error && (
        <p style={{ margin: "12px 0 0", fontSize: 12, color: "#DC2626" }}>
          <strong>Drive error:</strong> {error}
        </p>
      )}

      {connection && connectionState === "ready" && (
        <>
          <SearchBar
            value={searchInput}
            onChange={setSearchInput}
            onSubmit={handleSearch}
            onClear={() => {
              setSearchInput("");
              void loadRowsForCurrentLevel();
            }}
            searchActive={searchActive}
          />

          {!searchActive && (
            <Breadcrumb
              levels={browseStack}
              onJump={handleBreadcrumb}
            />
          )}

          <DriveFileList
            files={rows}
            loading={loadingRows}
            stagedIds={new Set(staged.map((s) => s.id))}
            onToggle={toggleStage}
            onEnterFolder={handleEnterFolder}
          />

          {staged.length > 0 && (
            <StagingArea
              staged={staged}
              onUnstage={(fileId) =>
                setStaged((prev) => prev.filter((s) => s.id !== fileId))
              }
              onStart={handleStart}
            />
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ConnectCard({
  connection,
  connectionState,
  connecting,
  onConnect,
  onDisconnect,
}: {
  connection: DriveConnection | null;
  connectionState: "loading" | "ready" | "ipc-pending";
  connecting: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  if (connectionState === "loading") {
    return (
      <div style={connectCard}>
        <strong style={{ fontSize: 13 }}>Checking Drive connection…</strong>
      </div>
    );
  }
  if (connectionState === "ipc-pending") {
    return (
      <div style={{ ...connectCard, borderStyle: "dashed" }}>
        <strong style={{ fontSize: 13, color: "var(--text-primary, #0F172A)" }}>
          Drive IPC pending
        </strong>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-secondary, #4B5563)" }}>
          The renderer-side Drive screen is shipped, but the Rust-side Tauri commands
          (<code>gdrive_start_oauth</code>, <code>gdrive_list_recent</code>, etc.) land alongside
          the rest of the vault Rust work in slice 12. Local + Paste imports still work.
        </p>
      </div>
    );
  }
  if (!connection) {
    return (
      <div style={connectCard}>
        <strong style={{ fontSize: 13 }}>Connect Google Drive</strong>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-secondary, #4B5563)" }}>
          You'll be sent to Google's consent screen. DreamLauncher requests
          <em> drive.readonly + drive.metadata.readonly</em> only -- read access, no writes.
        </p>
        <button
          type="button"
          onClick={onConnect}
          disabled={connecting}
          style={{ ...primaryBtn, marginTop: 10 }}
        >
          {connecting ? "Connecting…" : "Connect with Google"}
        </button>
      </div>
    );
  }
  return (
    <div style={connectCard}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <div>
          <strong style={{ fontSize: 13 }}>Connected to Google Drive</strong>
          <div style={{ fontSize: 12, color: "var(--text-secondary, #4B5563)" }}>
            {connection.accountEmail}
            <span style={{ marginLeft: 6, fontSize: 11, color: "var(--text-tertiary, #6B7280)" }}>
              · {connection.status}
            </span>
          </div>
        </div>
        <button type="button" onClick={onDisconnect} style={ghostBtn}>
          Disconnect
        </button>
      </div>
    </div>
  );
}

function SearchBar({
  value,
  onChange,
  onSubmit,
  onClear,
  searchActive,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onClear: () => void;
  searchActive: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        marginTop: 14,
        marginBottom: 10,
        alignItems: "center",
      }}
    >
      <input
        type="search"
        placeholder="Search Drive (e.g. 'investor deck', 'roadmap.pdf')"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
        }}
        style={{
          flex: 1,
          padding: "8px 10px",
          fontSize: 13,
          border: "1px solid var(--border-subtle, #E5E7EB)",
          borderRadius: 8,
          background: "var(--bg-surface, #FFFFFF)",
        }}
      />
      <button type="button" onClick={onSubmit} disabled={value.trim().length === 0} style={primaryBtn}>
        Search
      </button>
      {searchActive && (
        <button type="button" onClick={onClear} style={ghostBtn}>
          Clear
        </button>
      )}
    </div>
  );
}

function Breadcrumb({
  levels,
  onJump,
}: {
  levels: BrowseLevel[];
  onJump: (level: number) => void;
}) {
  return (
    <nav
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 4,
        alignItems: "center",
        fontSize: 12,
        marginBottom: 8,
        color: "var(--text-secondary, #4B5563)",
      }}
    >
      {levels.map((l, idx) => (
        <span key={`${l.folderId}-${idx}`} style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button
            type="button"
            onClick={() => onJump(idx)}
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: idx < levels.length - 1 ? "pointer" : "default",
              color:
                idx < levels.length - 1
                  ? "var(--accent, #4F46E5)"
                  : "var(--text-primary, #0F172A)",
              fontWeight: idx === levels.length - 1 ? 700 : 500,
              fontSize: 12,
            }}
          >
            {l.name}
          </button>
          {idx < levels.length - 1 && <span aria-hidden="true">/</span>}
        </span>
      ))}
    </nav>
  );
}

function DriveFileList({
  files,
  loading,
  stagedIds,
  onToggle,
  onEnterFolder,
}: {
  files: DriveFile[];
  loading: boolean;
  stagedIds: Set<string>;
  onToggle: (file: DriveFile) => void;
  onEnterFolder: (file: DriveFile) => void;
}) {
  if (loading) {
    return <p style={{ ...emptyHint, marginTop: 6 }}>Loading Drive…</p>;
  }
  if (files.length === 0) {
    return <p style={{ ...emptyHint, marginTop: 6 }}>No files in this view.</p>;
  }
  return (
    <ul
      style={{
        margin: 0,
        padding: 0,
        listStyle: "none",
        maxHeight: 280,
        overflowY: "auto",
        border: "1px solid var(--border-subtle, #E5E7EB)",
        borderRadius: 10,
      }}
    >
      {files.map((file, idx) => {
        const staged = stagedIds.has(file.id);
        return (
          <li
            key={file.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 12px",
              borderBottom: idx === files.length - 1 ? "none" : "1px solid var(--border-subtle, #E5E7EB)",
              fontSize: 12,
              background: staged ? "color-mix(in srgb, var(--accent, #4F46E5) 8%, transparent)" : "transparent",
              cursor: file.isFolder ? "pointer" : "default",
            }}
            onClick={file.isFolder ? () => onEnterFolder(file) : undefined}
            onKeyDown={(e) => {
              if (file.isFolder && (e.key === "Enter" || e.key === " ")) {
                onEnterFolder(file);
              }
            }}
          >
            {!file.isFolder && (
              <input
                type="checkbox"
                checked={staged}
                onChange={() => onToggle(file)}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Stage ${file.name}`}
              />
            )}
            <span aria-hidden="true" style={{ fontSize: 14 }}>
              {file.isFolder ? "📁" : file.isWorkspaceDoc ? "📄" : "📎"}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontWeight: 600,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={file.name}
              >
                {file.name}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary, #6B7280)" }}>
                {file.mimeType}
                {file.size !== undefined ? ` · ${formatBytes(file.size)}` : ""}
                {file.modifiedAt ? ` · ${new Date(file.modifiedAt).toLocaleString()}` : ""}
                {file.isWorkspaceDoc ? " · Workspace doc" : ""}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function StagingArea({
  staged,
  onUnstage,
  onStart,
}: {
  staged: DriveFile[];
  onUnstage: (fileId: string) => void;
  onStart: () => void;
}) {
  return (
    <section style={{ marginTop: 14 }}>
      <h4 style={{ margin: "0 0 8px", fontSize: 13 }}>
        Staged for import ({staged.length} {staged.length === 1 ? "file" : "files"})
      </h4>
      <ul style={{ margin: 0, padding: 0, listStyle: "none", maxHeight: 180, overflowY: "auto" }}>
        {staged.map((file) => (
          <li
            key={file.id}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "8px 10px",
              background: "var(--bg-muted, #F9FAFB)",
              border: "1px solid var(--border-subtle, #E5E7EB)",
              borderRadius: 8,
              marginBottom: 6,
              fontSize: 12,
            }}
          >
            <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {file.name}
              </strong>
              <span style={{ color: "var(--text-tertiary, #6B7280)" }}>
                {file.mimeType}
                {file.isWorkspaceDoc ? " · will export to Office format" : ""}
              </span>
            </span>
            <button
              type="button"
              onClick={() => onUnstage(file.id)}
              style={ghostBtn}
              aria-label={`Remove ${file.name}`}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={onStart} style={{ ...primaryBtn, marginTop: 8 }}>
        Start import →
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Helpers + styles
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const primaryBtn: React.CSSProperties = {
  padding: "8px 14px",
  background: "var(--accent, #4F46E5)",
  color: "var(--accent-fg, #FFFFFF)",
  border: "1px solid transparent",
  borderRadius: 8,
  fontWeight: 700,
  fontSize: 13,
  cursor: "pointer",
};

const ghostBtn: React.CSSProperties = {
  padding: "6px 12px",
  background: "transparent",
  color: "var(--text-secondary, #4B5563)",
  border: "1px solid var(--border-subtle, #E5E7EB)",
  borderRadius: 8,
  fontSize: 12,
  cursor: "pointer",
};

const connectCard: React.CSSProperties = {
  padding: 14,
  borderRadius: 12,
  border: "1px solid var(--border-subtle, #E5E7EB)",
  background: "var(--bg-surface, #FFFFFF)",
};

const emptyHint: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: "var(--text-tertiary, #6B7280)",
};
