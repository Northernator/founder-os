/**
 * VaultImportHubScreen -- "Choose how to import" landing screen.
 *
 * Three mode cards: local files / paste / Google Drive. All three are
 * active routes as of slice 11. Privacy copy mounted at the top is
 * non-optional.
 */
export type VaultImportHubScreenProps = {
  onPickLocal: () => void;
  onPickPaste: () => void;
  onPickDrive: () => void;
};

export function VaultImportHubScreen({ onPickLocal, onPickPaste, onPickDrive }: VaultImportHubScreenProps) {
  return (
    <div>
      <PrivacyBanner />

      <h3 style={{ margin: "8px 0 12px", fontSize: 16, fontWeight: 700 }}>
        How would you like to import?
      </h3>
      <p style={{ margin: "0 0 18px", color: "var(--text-secondary, #4B5563)", fontSize: 13 }}>
        DreamLauncher reads the files you choose, copies them into your local Dream Vault,
        and never touches the originals. Nothing is uploaded anywhere; nothing is published.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 12,
        }}
      >
        <ModeCard
          title="Local files & folders"
          description="Pick PDFs, DOCX, markdown, images, chat exports from your machine."
          ctaLabel="Choose files"
          onClick={onPickLocal}
        />
        <ModeCard
          title="Paste text"
          description="Paste a chat transcript, notes, or any markdown blob."
          ctaLabel="Paste in"
          onClick={onPickPaste}
        />
        <ModeCard
          title="Google Drive"
          description="Read-only picker. Search, browse, multi-select; Workspace docs export to Office formats automatically."
          ctaLabel="Connect Drive"
          onClick={onPickDrive}
        />
      </div>
    </div>
  );
}

function ModeCard({
  title,
  description,
  ctaLabel,
  onClick,
  disabled,
}: {
  title: string;
  description: string;
  ctaLabel: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        textAlign: "left",
        padding: 16,
        borderRadius: 12,
        border: "1px solid var(--border-subtle, #E5E7EB)",
        background: disabled ? "var(--bg-muted, #F3F4F6)" : "var(--bg-surface, #FFFFFF)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minHeight: 130,
      }}
    >
      <strong style={{ fontSize: 14 }}>{title}</strong>
      <span style={{ fontSize: 12, color: "var(--text-secondary, #4B5563)" }}>{description}</span>
      <span
        style={{
          marginTop: "auto",
          fontSize: 12,
          fontWeight: 700,
          color: disabled ? "var(--text-tertiary, #9CA3AF)" : "var(--accent, #4F46E5)",
        }}
      >
        {ctaLabel} →
      </span>
    </button>
  );
}

export function PrivacyBanner() {
  return (
    <div
      role="note"
      style={{
        background: "color-mix(in srgb, var(--accent, #4F46E5) 8%, transparent)",
        border: "1px solid color-mix(in srgb, var(--accent, #4F46E5) 22%, transparent)",
        borderRadius: 10,
        padding: "10px 12px",
        marginBottom: 16,
        fontSize: 12,
        color: "var(--text-secondary, #4B5563)",
        lineHeight: 1.5,
      }}
    >
      <strong style={{ color: "var(--text-primary, #0F172A)" }}>Your data stays on your device.</strong>{" "}
      Dream Vault is local-first. Files you import are copied into your workspace; the originals are
      untouched. Nothing is uploaded, published, or shared without your explicit action.
    </div>
  );
}
