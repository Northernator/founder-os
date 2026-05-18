/**
 * Dreamlauncher welcome screen (Open CoDesign reskin).
 *
 * Tricolor wordmark heading, sky-wash card background, journey button
 * with orb. All visual styles live in dreamlauncher.css; this component
 * just composes the markup. The journey button is optional: when an
 * `onStartJourney` prop is supplied, App.tsx wires it to the existing
 * NewVentureWizard so the hero CTA actually launches the wizard.
 */
export type WelcomeScreenProps = {
  onStartJourney?: () => void;
};

export function WelcomeScreen({ onStartJourney }: WelcomeScreenProps = {}) {
  return (
    <section
      className="dl-welcome screen-section"
      aria-labelledby="welcome-title"
      style={{ height: "100%" }}
    >
      <div className="dl-welcome-card fos-panel" data-fos-panel>
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
        {onStartJourney && (
          <button type="button" className="journey-button" onClick={onStartJourney}>
            <span className="orb" aria-hidden="true">
              🚀
            </span>
            <span>
              Start your journey
              <small>Create your first venture</small>
            </span>
          </button>
        )}
        <p className="trust">Trusted by innovators · All stages from A to Z</p>
      </div>
    </section>
  );
}
