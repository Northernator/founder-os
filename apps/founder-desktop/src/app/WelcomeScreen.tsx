/**
 * Dreamlauncher welcome screen (Open CoDesign reskin).
 *
 * Tricolor wordmark heading, sky-wash card background, journey button
 * with orb. All visual styles live in dreamlauncher.css; this component
 * just composes the markup. The journey button is optional: when an
 * `onStartJourney` prop is supplied, App.tsx wires it to the existing
 * NewVentureWizard so the hero CTA actually launches the wizard.
 */
import { HomeVaultButtons } from "../features/vault/HomeVaultButtons.js";
import type { PendingVaultImport, RecoveredVaultImport } from "../features/vault/types.js";
import { VaultPendingImportsPanel } from "../features/vault/VaultPendingImportsPanel.js";

export type WelcomeScreenProps = {
  onStartJourney?: () => void;
  onImportToVault?: () => void;
  onOpenVault?: () => void;
  /** When provided, a pending-imports gate row is mounted above the hero card. */
  pendingVaultImports?: ReadonlyMap<string, PendingVaultImport>;
  /** Rust IPC arc slice 4 -- recovered jobs from previous sessions. */
  recoveredVaultImports?: ReadonlyMap<string, RecoveredVaultImport>;
  onReviewPending?: (jobId: string) => void;
  onDiscardPending?: (jobId: string) => void;
  onDiscardRecovered?: (jobId: string) => void;
};

export function WelcomeScreen({
  onStartJourney,
  onImportToVault,
  onOpenVault,
  pendingVaultImports,
  recoveredVaultImports,
  onReviewPending,
  onDiscardPending,
  onDiscardRecovered,
}: WelcomeScreenProps = {}) {
  const hasLive = (pendingVaultImports?.size ?? 0) > 0;
  const hasRecovered = (recoveredVaultImports?.size ?? 0) > 0;
  return (
    <section
      className="dl-welcome screen-section"
      aria-labelledby="welcome-title"
      style={{ height: "100%" }}
    >
      <div className="dl-welcome-card fos-panel" data-fos-panel>
        {pendingVaultImports && onReviewPending && onDiscardPending && (hasLive || hasRecovered) && (
          <div style={{ width: "100%", maxWidth: 720, marginBottom: 18 }}>
            <VaultPendingImportsPanel
              imports={pendingVaultImports}
              {...(recoveredVaultImports ? { recovered: recoveredVaultImports } : {})}
              onReview={onReviewPending}
              onDiscard={onDiscardPending}
              {...(onDiscardRecovered ? { onDiscardRecovered } : {})}
            />
          </div>
        )}
        <div className="hero-rocket" aria-hidden="true">
          🚀
        </div>
        <h1 id="welcome-title">
          <span className="dream">Dream</span>
          <span className="launch">Launch</span>
          <span className="er">er</span>
        </h1>
        <p className="headline">Launch your software from idea to impact.</p>
        <p className="subhead">
          Pick a venture or create a new one. Dreamlauncher turns raw founder energy into research,
          specs, screens, handoff, build, audit, launch, media, and CRM momentum.
        </p>
        {onStartJourney && onImportToVault && onOpenVault ? (
          <div style={{ marginTop: 16, width: "100%", maxWidth: 720 }}>
            <HomeVaultButtons
              onImport={onImportToVault}
              onNewVenture={onStartJourney}
              onOpenVault={onOpenVault}
              variant="hero"
            />
          </div>
        ) : (
          onStartJourney && (
            <button type="button" className="journey-button" onClick={onStartJourney}>
              <span className="orb" aria-hidden="true">
                🚀
              </span>
              <span>
                Start your journey
                <small>Create your first venture</small>
              </span>
            </button>
          )
        )}
        <p className="trust">Trusted by innovators · All stages from A to Z</p>
      </div>
    </section>
  );
}
