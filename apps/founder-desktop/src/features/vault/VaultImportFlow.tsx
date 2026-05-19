/**
 * VaultImportFlow -- entry point for the Dream Vault import wizard.
 *
 * The desktop app currently has no react-router setup; this component
 * manages its own internal screen state so the rest of the app stays
 * shallow. The spec's logical routes (/import, /import/local,
 * /import/paste, /import/jobs/:jobId, /import/jobs/:jobId/review)
 * map onto:
 *
 *   hub      -> "Choose how to import"
 *   local    -> "Pick local files / folder"
 *   paste    -> "Paste a chat or transcript"
 *   progress -> "Running phases 1-9, ready for review at the end"
 *   review   -> "Approve drafts and commit to the vault"
 *
 * Google Drive is documented in the spec but deferred per the user's
 * call -- the option is rendered as "Coming soon" so the seam is
 * obvious when slice 11 lands.
 *
 * Slice 10 additions:
 *   - The progress screen bubbles needs_review up to App.tsx via
 *     onReadyForReview so the run stays reviewable even after this
 *     modal closes (the VaultPendingImportsPanel rendezvous).
 *   - The flow now hosts the review screen as a fourth internal stop.
 *     App.tsx may also open the flow directly into review for a
 *     previously-pending entry via `initialReviewJobId`.
 */
import { type Venture } from "@founder-os/domain";
import { useCallback, useMemo, useState } from "react";
import type { RunVaultImportResult } from "./run-vault-import.js";
import { VaultImportDriveScreen } from "./screens/VaultImportDriveScreen.js";
import { VaultImportHubScreen } from "./screens/VaultImportHubScreen.js";
import { VaultImportLocalScreen } from "./screens/VaultImportLocalScreen.js";
import { VaultImportPasteScreen } from "./screens/VaultImportPasteScreen.js";
import { VaultImportProgressScreen } from "./screens/VaultImportProgressScreen.js";
import { VaultImportReviewScreen } from "./screens/VaultImportReviewScreen.js";
import type { PendingVaultImport, RecentVaultImport } from "./types.js";

export type VaultImportScreen = "hub" | "local" | "paste" | "drive" | "progress" | "review";

export type VaultImportFlowProps = {
  /** Workspace root passed through to run-vault-import.ts. */
  workspaceRoot: string;
  /** Ventures the project-classifier scores incoming sources against. */
  ventures: Venture[];
  /** The most-recently-active venture id -- threaded to pipeline-llm. */
  activeVentureId?: string | null;
  /** All pending vault imports the App holds. Used when the user
   *  reopens the flow on an already-pending job to jump straight to
   *  review. */
  pendingImports: ReadonlyMap<string, PendingVaultImport>;
  /** When set, the flow boots directly into review for this job. */
  initialReviewJobId?: string | null;
  /** Called when the run reaches needs_review so App can stash the
   *  result + surface the row in the pending panel. */
  onReadyForReview: (jobId: string, result: RunVaultImportResult) => void;
  /** Called after finalize() resolves successfully. */
  onCommitted: (recent: RecentVaultImport) => void;
  /** Closes the flow + returns to whatever screen invoked it. */
  onClose: () => void;
};

export function VaultImportFlow({
  workspaceRoot,
  ventures,
  activeVentureId,
  pendingImports,
  initialReviewJobId,
  onReadyForReview,
  onCommitted,
  onClose,
}: VaultImportFlowProps) {
  const [screen, setScreen] = useState<VaultImportScreen>(
    initialReviewJobId ? "review" : "hub"
  );
  const [progressJobId, setProgressJobId] = useState<string | null>(
    initialReviewJobId ?? null
  );
  const [stagedSources, setStagedSources] = useState<
    React.ComponentProps<typeof VaultImportProgressScreen>["sources"] | null
  >(null);
  const [stagedProvider, setStagedProvider] = useState<
    NonNullable<React.ComponentProps<typeof VaultImportProgressScreen>["provider"]>
  >("local");
  const [stagedMode, setStagedMode] = useState<
    NonNullable<React.ComponentProps<typeof VaultImportProgressScreen>["mode"]>
  >("files");
  const [reviewingJobId, setReviewingJobId] = useState<string | null>(
    initialReviewJobId ?? null
  );

  const handleStartProgress = useCallback(
    (
      sources: NonNullable<typeof stagedSources>,
      jobId: string,
      provider: typeof stagedProvider = "local",
      mode: typeof stagedMode = "files"
    ) => {
      setStagedSources(sources);
      setStagedProvider(provider);
      setStagedMode(mode);
      setProgressJobId(jobId);
      setScreen("progress");
    },
    []
  );

  const handleReadyForReview = useCallback(
    (jobId: string, result: RunVaultImportResult) => {
      onReadyForReview(jobId, result);
      setReviewingJobId(jobId);
      // Stay on progress until user clicks "Review imports →".
    },
    [onReadyForReview]
  );

  const pendingForReview = useMemo<PendingVaultImport | null>(
    () => (reviewingJobId ? pendingImports.get(reviewingJobId) ?? null : null),
    [pendingImports, reviewingJobId]
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="vault-import-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 24,
      }}
    >
      <div
        style={{
          background: "var(--bg-surface, #FFFFFF)",
          color: "var(--text-primary, #0F172A)",
          width: "min(960px, 100%)",
          maxHeight: "92vh",
          borderRadius: 16,
          boxShadow: "0 24px 48px rgba(15, 23, 42, 0.25)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <header
          style={{
            padding: "18px 22px",
            borderBottom: "1px solid var(--border-subtle, #E5E7EB)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <h2 id="vault-import-title" style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
            {screen === "review" ? "Review Dream Vault import" : "Import to Dream Vault"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close import flow"
            style={{
              background: "transparent",
              border: "1px solid var(--border-subtle, #E5E7EB)",
              borderRadius: 8,
              padding: "4px 10px",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Close
          </button>
        </header>

        <div style={{ padding: 22, overflowY: "auto" }}>
          {screen === "hub" && (
            <VaultImportHubScreen
              onPickLocal={() => setScreen("local")}
              onPickPaste={() => setScreen("paste")}
              onPickDrive={() => setScreen("drive")}
            />
          )}
          {screen === "local" && (
            <VaultImportLocalScreen
              onBack={() => setScreen("hub")}
              onStartImport={(sources, jobId) => handleStartProgress(sources, jobId, "local", "files")}
            />
          )}
          {screen === "paste" && (
            <VaultImportPasteScreen
              onBack={() => setScreen("hub")}
              onStartImport={(sources, jobId) => handleStartProgress(sources, jobId, "paste", "paste_text")}
            />
          )}
          {screen === "drive" && (
            <VaultImportDriveScreen
              onBack={() => setScreen("hub")}
              onStartImport={(sources, jobId) =>
                handleStartProgress(sources, jobId, "google_drive", "drive_files")
              }
            />
          )}
          {screen === "progress" && stagedSources && progressJobId && (
            <VaultImportProgressScreen
              jobId={progressJobId}
              sources={stagedSources}
              workspaceRoot={workspaceRoot}
              ventures={ventures}
              activeVentureId={activeVentureId ?? null}
              provider={stagedProvider}
              mode={stagedMode}
              onDone={onClose}
              onReadyForReview={handleReadyForReview}
              onReviewNow={() => setScreen("review")}
            />
          )}
          {screen === "review" && pendingForReview && (
            <VaultImportReviewScreen
              pending={pendingForReview}
              ventures={ventures}
              onCommitted={(recent) => {
                onCommitted(recent);
                onClose();
              }}
              onClose={onClose}
            />
          )}
          {screen === "review" && !pendingForReview && (
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-tertiary, #6B7280)" }}>
              Review entry not found. Close this dialog and pick the import again from
              "Pending vault imports".
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
