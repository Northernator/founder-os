import { FounderQueryProvider } from "@founder-os/query";
import { useVentureStore } from "@founder-os/state";
import { AppShell, Sidebar } from "@founder-os/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ThemeToggle } from "../features/chrome/ThemeToggle.js";
import { ToastContainer } from "../features/toasts/ToastContainer.js";
import { DreamVaultBrowser } from "../features/vault/DreamVaultBrowser.js";
import {
  discardRecoveredVaultJob,
  hydrateResumableVaultJobs,
} from "../features/vault/boot-hydration.js";
import type { RunVaultImportResult } from "../features/vault/run-vault-import.js";
import type {
  PendingVaultImport,
  RecentVaultImport,
  RecoveredVaultImport,
} from "../features/vault/types.js";
import { VaultImportFlow } from "../features/vault/VaultImportFlow.js";
import {
  type CreateVentureInput,
  NewVentureWizard,
} from "../features/ventures/NewVentureWizard.js";
import { VentureDashboard } from "../features/ventures/VentureDashboard.js";
import * as db from "../lib/db.js";
import { pushToast } from "../lib/toasts.js";
import { provisionVentureWorkspace } from "../lib/venture-io.js";
import { WelcomeScreen } from "./WelcomeScreen.js";

/**
 * Derive the workspace root from the venture set.
 *
 * Each venture lives at `<workspaceRoot>/<slug>/`; the vault sits as
 * a sibling at `<workspaceRoot>/_vault/`. We resolve the root by
 * stripping the last path segment off a venture's `rootPath`.
 *
 * Resolution order:
 *   1. Active venture's rootPath if one is selected.
 *   2. First known venture's rootPath as a fall-back -- ventures in
 *      this app are conventionally siblings under one root, so any
 *      venture pins the workspace.
 *   3. `null` when there are no ventures at all. **Returning `null`
 *      instead of a `/workspace` placeholder is intentional**: the
 *      old placeholder leaked into Rust and caused an `os error 3`
 *      ("path not found") inside `_vault/_import-cache/...` because
 *      `C:\workspace\_vault\...` doesn't exist on a fresh machine.
 *      Callers handle `null` by blocking the import flow with an
 *      empty state until a venture is created (or a settings-side
 *      workspace folder is wired in a future arc).
 */
function deriveWorkspaceRoot(
  activeVentureRootPath: string | null | undefined,
  ventures: ReadonlyArray<{ rootPath: string }>
): string | null {
  const pickParent = (rootPath: string): string => {
    const trimmed = rootPath.replace(/[\\/]+$/, "");
    const lastSep = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    return lastSep > 0 ? trimmed.slice(0, lastSep) : trimmed;
  };
  if (activeVentureRootPath) return pickParent(activeVentureRootPath);
  const first = ventures[0];
  if (first?.rootPath) return pickParent(first.rootPath);
  return null;
}

// Small helper — inline so App.tsx doesn't depend on db.ts internals.
// Same shape as db.ts and venture-io.ts. If we grow a third instance
// consider hoisting to a shared lib/errors.ts.
function errDetail(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// Global CSS reset
const globalStyle = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body { overflow-x: hidden; max-width: 100vw; }
  body { margin: 0; padding: 0; font-family: Inter, system-ui, sans-serif; }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  @keyframes bounce {
    0%, 100% { transform: translateY(0); opacity: 0.4; }
    50% { transform: translateY(-6px); opacity: 1; }
  }
  /* Cue pulse — used by the Generate Reports button when the research
     intake assistant signals READY_TO_GENERATE_REPORTS. Gentle box-shadow
     breathing so the eye is drawn without feeling anxious. Separate from
     bounce above: that's for "activity" (typing indicator), this is for
     "your attention is requested". */
  @keyframes cuePulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.45); }
    50% { box-shadow: 0 0 0 6px rgba(99, 102, 241, 0); }
  }
`;

export function App() {
  const {
    ventures,
    activeVentureId,
    setActiveVenture,
    addVenture,
    setVentures,
    setLoading,
    setError,
  } = useVentureStore();
  const [showWizard, setShowWizard] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  /** Tracks which top-level vault surface is open (slice 9 DREAM_VAULT). */
  const [vaultScreen, setVaultScreen] = useState<"import" | "browser" | null>(null);
  /**
   * Slice 10 -- in-renderer registry of vault imports awaiting review.
   * Keyed by jobId. Persists across modal close/open while the app is
   * running; cleared on reload (Rust persistence lands slice 12).
   */
  const [pendingVaultImports, setPendingVaultImports] = useState<
    ReadonlyMap<string, PendingVaultImport>
  >(() => new Map());
  /** Most-recently-committed vault import runs (in-memory, newest first). */
  const [recentVaultImports, setRecentVaultImports] = useState<ReadonlyArray<RecentVaultImport>>(
    () => []
  );
  /**
   * Rust IPC arc slice 4 -- jobs recovered from SQLite on boot. These
   * are pending-review entries from a previous session whose runner
   * state was lost on reload. The user can only discard them; full
   * resume requires drafts/items/matches persistence which is a
   * separate arc.
   */
  const [recoveredVaultImports, setRecoveredVaultImports] = useState<
    ReadonlyMap<string, RecoveredVaultImport>
  >(() => new Map());
  /** When set, the next time VaultImportFlow mounts it boots into review for this job. */
  const [reviewJobId, setReviewJobId] = useState<string | null>(null);

  const activeVenture = useMemo(
    () => ventures.find((v) => v.id === activeVentureId) ?? null,
    [ventures, activeVentureId]
  );
  const workspaceRoot = useMemo(
    () => deriveWorkspaceRoot(activeVenture?.rootPath, ventures),
    [activeVenture, ventures]
  );

  // Boot-time keychain drain (pt.23). Runs in parallel with venture
  // hydration — the result doesn't gate the UI. Most users see a silent
  // no-op (flag already set, or zero plaintext rows to move). We only
  // toast when something meaningful happened: a successful move, or a
  // partial failure that left plaintext on disk.
  useEffect(() => {
    let cancelled = false;
    db.drainPlaintextKeysToKeychain()
      .then((stats) => {
        if (cancelled) return;
        if (stats.alreadyMigrated) return;
        if (stats.failed > 0) {
          // Partial success — some providers still have plaintext rows.
          // Flag remains unset so next boot retries. Warn (not error)
          // because API keys still work via the legacy fallback path;
          // nothing is actively broken, just suboptimal.
          pushToast({
            kind: "warn",
            message: `Keychain migration incomplete — ${stats.failed} provider(s) still in plaintext`,
            detail: "We'll retry on next launch. Check your OS credential store permissions.",
          });
        } else if (stats.moved > 0) {
          pushToast({
            kind: "success",
            message: `Moved ${stats.moved} API key(s) into OS keychain`,
          });
        }
        // stats.moved === 0 && stats.failed === 0 → silently stamped the
        // flag (no plaintext rows existed). No toast — most installs
        // hit this path and a success toast would be meaningless noise.
      })
      .catch((err) => {
        if (cancelled) return;
        // Don't pushToast here — this catch covers rare edge cases like
        // SQLite being unreachable, which will have already surfaced via
        // the hydrate effect's own error toast. Avoid double-toasting.
        console.warn("[db] keychain drain failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Resumable-imports arc: boot hydration. Two strategies layered:
  //   1. hydrateResumableVaultJobs -- reconstructs full
  //      PendingVaultImport entries (with a Tauri-backed finalize)
  //      from persisted drafts / matches / items.
  //   2. Legacy recovered map -- jobs whose drafts weren't persisted
  //      (pre-resumable-arc imports or runs that failed mid-persist).
  //      Surface as discard-only.
  // Done in a separate effect from the venture hydrate so it doesn't
  // gate the welcome screen. Depends on `workspaceRoot` because
  // resumed-finalize needs it for path resolution.
  useEffect(() => {
    if (workspaceRoot === null) return;
    let cancelled = false;
    hydrateResumableVaultJobs({ workspaceRoot })
      .then(({ resumable, legacyRecovered }) => {
        if (cancelled) return;
        if (resumable.size > 0) {
          setPendingVaultImports((prev) => {
            // In-session entries (live runner) win over resumed ones
            // (Tauri-backed finalize). Same jobId surfaces in both
            // when persistRunForResume has written the row -- prev
            // already has the better one with the live runner.
            const next = new Map(prev);
            for (const [k, v] of resumable) {
              if (!next.has(k)) next.set(k, v);
            }
            return next;
          });
        }
        if (legacyRecovered.size > 0) setRecoveredVaultImports(legacyRecovered);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("[vault] boot hydration failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceRoot]);

  // Schema drift smoke test (db_smoke.rs). The Rust side fires the
  // probe automatically on boot + emits `db:schema-smoke`; we listen
  // here and toast a loud warning if any required table is missing.
  // Catches the misplaced-migration class of bug (see slice 1 of the
  // Rust IPC arc for the original incident).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<{ ok: boolean; missing: string[]; total: number; dbPath: string }>(
          "db:schema-smoke",
          (event) => {
            if (event.payload.ok) return;
            pushToast({
              kind: "error",
              message: `Database schema drift: ${event.payload.missing.length} of ${event.payload.total} tables missing`,
              detail: `Missing: ${event.payload.missing.slice(0, 5).join(", ")}${
                event.payload.missing.length > 5 ? ", …" : ""
              }. Check db_smoke.rs for the migration-misplacement playbook.`,
              ttlMs: 12000,
            });
          }
        );
      } catch (err) {
        console.warn("[db_smoke] failed to subscribe to db:schema-smoke", err);
      }
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Hydrate from SQLite on first mount.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    db.listVentures()
      .then((rows) => {
        if (cancelled) return;
        setVentures(rows);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[db] hydrate failed", err);
        // Sticky error toast — hydration failure means the app boots into
        // an empty WelcomeScreen with no hint why. The zustand store's
        // `error` field doesn't render at the app level either (the banner
        // lives inside VentureDashboard). Without this toast the user
        // sees "no ventures" and has no idea it's a load failure, not a
        // fresh install.
        pushToast({
          kind: "error",
          message: "Couldn't load ventures from database",
          detail: errDetail(err),
        });
        setError(errDetail(err));
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setHydrated(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [setVentures, setLoading, setError]);

  const handleCreate = async ({ venture, manifest }: CreateVentureInput) => {
    // Order matters:
    // 1. Scaffold disk first — if this fails, we haven't polluted the DB.
    // 2. Then persist to SQLite — if this fails after disk succeeded, the
    //    folder exists on disk but won't appear in the sidebar on reload.
    //    Acceptable: user can see the orphaned folder and retry, or we'll
    //    add a "rescue from disk" path later.
    // 3. Finally update zustand + close wizard.
    try {
      await provisionVentureWorkspace(venture.rootPath, manifest);
    } catch (err) {
      console.error("[fs] provisionVentureWorkspace failed", err);
      // Sticky error toast — the wizard *does* render its own inline error
      // before it's dismissed, but failures here leave orphaned state
      // worth surfacing outside the wizard too (e.g. if the user hits the
      // close button on the inline error and then wonders what happened).
      pushToast({
        kind: "error",
        message: "Couldn't create venture folder on disk",
        detail: errDetail(err),
      });
      setError(errDetail(err));
      // Re-throw so the wizard's own error state + submitting flag reset.
      throw err;
    }

    try {
      await db.insertVenture(venture);
    } catch (err) {
      console.error("[db] insertVenture failed", err);
      // Particularly nasty — the folder was scaffolded on disk, but the
      // DB row failed. Sticky toast tells the user exactly what went
      // wrong and suggests they can retry with the same name (the
      // disk-write is idempotent re: provisionVentureWorkspace).
      pushToast({
        kind: "error",
        message: "Couldn't save venture to database",
        detail: `${errDetail(err)} — the folder was created on disk; retry to re-save the DB record.`,
      });
      setError(errDetail(err));
      throw err;
    }

    addVenture(venture);
    setActiveVenture(venture.id);
    setShowWizard(false);
  };

  // ---------------------------------------------------------------------------
  // Vault-import lifecycle callbacks (slice 10).
  // ---------------------------------------------------------------------------

  const handleReadyForReview = useCallback(
    (jobId: string, result: RunVaultImportResult) => {
      const entry: PendingVaultImport = {
        jobId,
        result,
        sources: [],
        llmConfigured: result.llmConfigured,
        readyAt: new Date().toISOString(),
      };
      // The sources array is best-effort -- the runner has them inside
      // result.run.perSource[].source, so we project a thin shape.
      entry.sources = result.run.perSource.map((p) => ({
        absolutePath: p.source.cachedOriginalPath,
        originalName: p.source.originalName,
        sourceType: p.source.sourceType,
        ...(p.source.fileExtension ? { fileExtension: p.source.fileExtension } : {}),
        ...(p.source.mimeType ? { mimeType: p.source.mimeType } : {}),
        ...(p.source.byteSize !== undefined ? { byteSize: p.source.byteSize } : {}),
      }));
      setPendingVaultImports((prev) => {
        const next = new Map(prev);
        next.set(jobId, entry);
        return next;
      });
    },
    []
  );

  const handleVaultCommitted = useCallback((recent: RecentVaultImport) => {
    setPendingVaultImports((prev) => {
      if (!prev.has(recent.jobId)) return prev;
      const next = new Map(prev);
      next.delete(recent.jobId);
      return next;
    });
    setRecentVaultImports((prev) => [recent, ...prev].slice(0, 25));
  }, []);

  const handleDiscardPending = useCallback((jobId: string) => {
    setPendingVaultImports((prev) => {
      if (!prev.has(jobId)) return prev;
      const next = new Map(prev);
      next.delete(jobId);
      return next;
    });
    pushToast({
      kind: "info",
      message: "Pending vault import discarded",
      detail: "Drafts dropped. Re-run the import if you want to review again.",
      ttlMs: 4000,
    });
  }, []);

  const handleReviewPending = useCallback((jobId: string) => {
    setReviewJobId(jobId);
    setVaultScreen("import");
  }, []);

  /**
   * Drop a recovered-from-SQLite entry. Tries the Rust hard-delete
   * first; even when that's not wired, we clear local state so the
   * row stops surfacing in the panel.
   */
  const handleDiscardRecovered = useCallback((jobId: string) => {
    void discardRecoveredVaultJob(jobId);
    setRecoveredVaultImports((prev) => {
      if (!prev.has(jobId)) return prev;
      const next = new Map(prev);
      next.delete(jobId);
      return next;
    });
    pushToast({
      kind: "info",
      message: "Recovered vault import discarded",
      detail: "The previous session's job + source rows are gone.",
      ttlMs: 4000,
    });
  }, []);

  return (
    <>
      <style>{globalStyle}</style>
      <FounderQueryProvider>
        <AppShell
          sidebar={
            <Sidebar
              ventures={ventures}
              activeVentureId={activeVentureId}
              onSelectVenture={setActiveVenture}
              onNewVenture={() => setShowWizard(true)}
              onImportToVault={() => setVaultScreen("import")}
              onOpenVault={() => setVaultScreen("browser")}
            />
          }
        >
          {!hydrated ? (
            <LoadingScreen />
          ) : vaultScreen === "browser" ? (
            <DreamVaultBrowser
              ventures={ventures}
              activeVenture={activeVenture}
              pendingImports={pendingVaultImports}
              recoveredImports={recoveredVaultImports}
              recentImports={recentVaultImports}
              onStartImport={() => {
                setReviewJobId(null);
                setVaultScreen("import");
              }}
              onReviewPending={handleReviewPending}
              onDiscardPending={handleDiscardPending}
              onDiscardRecovered={handleDiscardRecovered}
              onClose={() => setVaultScreen(null)}
            />
          ) : activeVentureId ? (
            <VentureDashboard ventureId={activeVentureId} />
          ) : (
            <WelcomeScreen
              onStartJourney={() => setShowWizard(true)}
              onImportToVault={() => {
                setReviewJobId(null);
                setVaultScreen("import");
              }}
              onOpenVault={() => setVaultScreen("browser")}
              pendingVaultImports={pendingVaultImports}
              recoveredVaultImports={recoveredVaultImports}
              onReviewPending={handleReviewPending}
              onDiscardPending={handleDiscardPending}
              onDiscardRecovered={handleDiscardRecovered}
            />
          )}
        </AppShell>

        {showWizard && (
          <NewVentureWizard onClose={() => setShowWizard(false)} onCreate={handleCreate} />
        )}

        {vaultScreen === "import" && (
          <VaultImportFlow
            workspaceRoot={workspaceRoot}
            ventures={ventures}
            activeVentureId={activeVentureId}
            pendingImports={pendingVaultImports}
            initialReviewJobId={reviewJobId}
            onReadyForReview={handleReadyForReview}
            onCommitted={handleVaultCommitted}
            onClose={() => {
              setVaultScreen(null);
              setReviewJobId(null);
            }}
          />
        )}

        {/* Top-right theme toggle. The pill variant carries its own
            position:fixed so it floats above the main content regardless
            of which screen is mounted (Welcome, VentureDashboard, etc.).
            One source of truth; the Options-tab copy reads the same
            store. */}
        <ThemeToggle />

        {/* App-wide toast surface. Mounted once so every db/keyring path can
            push notifications via `pushToast` without threading a ref. */}
        <ToastContainer />
      </FounderQueryProvider>
    </>
  );
}

function LoadingScreen() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        color: "var(--text-muted)",
        fontSize: 14,
      }}
    >
      Loading…
    </div>
  );
}
