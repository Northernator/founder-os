import { FounderQueryProvider } from "@founder-os/query";
import { useVentureStore } from "@founder-os/state";
import { AppShell, Sidebar } from "@founder-os/ui";
import { useEffect, useState } from "react";
import { ThemeToggle } from "../features/chrome/ThemeToggle.js";
import { ToastContainer } from "../features/toasts/ToastContainer.js";
import {
  type CreateVentureInput,
  NewVentureWizard,
} from "../features/ventures/NewVentureWizard.js";
import { VentureDashboard } from "../features/ventures/VentureDashboard.js";
import * as db from "../lib/db.js";
import { pushToast } from "../lib/toasts.js";
import { provisionVentureWorkspace } from "../lib/venture-io.js";
import { WelcomeScreen } from "./WelcomeScreen.js";

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
            />
          }
        >
          {!hydrated ? (
            <LoadingScreen />
          ) : activeVentureId ? (
            <VentureDashboard ventureId={activeVentureId} />
          ) : (
            <WelcomeScreen onStartJourney={() => setShowWizard(true)} />
          )}
        </AppShell>

        {showWizard && (
          <NewVentureWizard onClose={() => setShowWizard(false)} onCreate={handleCreate} />
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
