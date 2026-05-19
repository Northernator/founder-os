/**
 * HomeVaultButtons -- three primary actions on the home / welcome surface.
 *
 * Order per DREAM-VAULT-MODULE-SPEC.md §3 slice 9:
 *   1. Import AI Chats & Docs
 *   2. New Venture
 *   3. View Dream Vault
 *
 * Mounted from both WelcomeScreen (when no venture is active) and the
 * sidebar (always reachable). Each button is a pure callback fan-out --
 * App.tsx owns the state machine.
 */
export type HomeVaultButtonsProps = {
  onImport: () => void;
  onNewVenture: () => void;
  onOpenVault: () => void;
  /** Compact layout fits inside the sidebar; default expanded layout for hero. */
  variant?: "hero" | "compact";
};

export function HomeVaultButtons({
  onImport,
  onNewVenture,
  onOpenVault,
  variant = "hero",
}: HomeVaultButtonsProps) {
  const isCompact = variant === "compact";
  const container: React.CSSProperties = isCompact
    ? { display: "flex", flexDirection: "column", gap: 6 }
    : { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 };

  return (
    <div style={container}>
      <ActionButton
        emoji="📥"
        label="Import AI Chats & Docs"
        sub={isCompact ? undefined : "Bring chats, docs, images into the Dream Vault"}
        onClick={onImport}
        variant={variant}
      />
      <ActionButton
        emoji="🚀"
        label="New Venture"
        sub={isCompact ? undefined : "Start a fresh venture workspace"}
        onClick={onNewVenture}
        variant={variant}
        primary
      />
      <ActionButton
        emoji="📚"
        label="View Dream Vault"
        sub={isCompact ? undefined : "Browse imported notes, prompts, decisions"}
        onClick={onOpenVault}
        variant={variant}
      />
    </div>
  );
}

function ActionButton({
  emoji,
  label,
  sub,
  onClick,
  variant,
  primary,
}: {
  emoji: string;
  label: string;
  sub?: string;
  onClick: () => void;
  variant: "hero" | "compact";
  primary?: boolean;
}) {
  const isCompact = variant === "compact";
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: "left",
        padding: isCompact ? "8px 10px" : "14px 16px",
        background: primary ? "var(--accent, #4F46E5)" : "var(--bg-surface, #FFFFFF)",
        color: primary ? "var(--accent-fg, #FFFFFF)" : "var(--text-primary, #0F172A)",
        border: primary ? "1px solid transparent" : "1px solid var(--border-subtle, #E5E7EB)",
        borderRadius: isCompact ? 8 : 12,
        cursor: "pointer",
        fontWeight: 700,
        display: "flex",
        alignItems: isCompact ? "center" : "flex-start",
        flexDirection: isCompact ? "row" : "column",
        gap: isCompact ? 8 : 4,
        boxShadow: primary ? "0 6px 16px rgba(79, 70, 229, 0.25)" : "0 2px 8px rgba(15, 23, 42, 0.04)",
        transition: "transform .12s ease, box-shadow .18s ease",
      }}
    >
      <span style={{ fontSize: isCompact ? 16 : 22 }} aria-hidden="true">
        {emoji}
      </span>
      <span style={{ fontSize: isCompact ? 12 : 14, fontWeight: 700 }}>{label}</span>
      {sub && (
        <span
          style={{
            fontSize: 12,
            fontWeight: 400,
            color: primary ? "rgba(255,255,255,0.85)" : "var(--text-secondary, #4B5563)",
          }}
        >
          {sub}
        </span>
      )}
    </button>
  );
}
