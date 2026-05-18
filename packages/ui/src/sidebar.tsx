import type { VentureStage } from "@founder-os/domain";

export type SidebarVenture = {
  id: string;
  name: string;
  stage: VentureStage;
};

export type SidebarProps = {
  ventures: SidebarVenture[];
  activeVentureId?: string | null;
  onSelectVenture?: (id: string) => void;
  onNewVenture?: () => void;
};

const STAGE_EMOJI: Record<string, string> = {
  IDEA: "💡",
  RESEARCHED: "🔍",
  VALIDATED: "✅",
  BRAND_READY: "🎨",
  UK_SETUP_READY: "🇬🇧",
  SPEC_READY: "📋",
  WIREFRAME_READY: "🖼️",
  STITCH_READY: "🧵",
  BUILD_READY: "🔨",
  AUDIT_READY: "🔒",
  LAUNCH_READY: "🚀",
  LIVE: "🌍",
};

export function Sidebar({
  ventures,
  activeVentureId,
  onSelectVenture,
  onNewVenture,
}: SidebarProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Dreamlauncher brand lockup -- cloud + rocket mark + tricolor
          wordmark + tagline. All styles in dreamlauncher.css under
          `.brand-lockup`. */}
      <div className="brand-lockup">
        <div className="logo-line">
          <div className="mark" aria-hidden="true">
            <span className="cloud-mark" />
            <span className="rocket-mark" />
          </div>
          <div className="wordmark" aria-label="Dreamlauncher">
            <span>Dream</span>
            <span>Launch</span>
            <span>er</span>
          </div>
        </div>
        <p className="tagline">From idea to launch in one workspace.</p>
      </div>

      {/* Ventures list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "10px 8px" }}>
        {ventures.map((v) => {
          const active = v.id === activeVentureId;
          return (
            <button
              type="button"
              key={v.id}
              onClick={() => onSelectVenture?.(v.id)}
              style={{
                width: "100%",
                border: active
                  ? "1px solid color-mix(in srgb, var(--accent) 28%, transparent)"
                  : "1px solid transparent",
                background: active ? "var(--bg-selected)" : "transparent",
                color: "var(--text-primary)",
                borderRadius: "var(--radius-lg)",
                display: "grid",
                gridTemplateColumns: "28px 1fr",
                gap: 8,
                padding: "calc(9px * var(--density)) 9px",
                textAlign: "left",
                transition: ".18s ease",
                cursor: "pointer",
                boxShadow: active ? "inset 3px 0 0 var(--accent)" : undefined,
                marginBottom: 2,
              }}
            >
              <span style={{ fontSize: 18, lineHeight: 1.2 }}>{STAGE_EMOJI[v.stage] ?? "•"}</span>
              <span>
                <span
                  style={{
                    display: "block",
                    fontWeight: 700,
                    fontSize: 13,
                    color: "var(--text-secondary)",
                  }}
                >
                  {v.name}
                </span>
                <span
                  style={{
                    display: "block",
                    marginTop: 2,
                    fontSize: 11,
                    color: "var(--text-tertiary)",
                  }}
                >
                  {v.stage.replace(/_/g, " ")}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {/* New venture button */}
      <div
        style={{
          padding: "13px 14px 16px",
          borderTop: "1px solid var(--border-subtle)",
        }}
      >
        <button
          type="button"
          onClick={onNewVenture}
          style={{
            width: "100%",
            padding: "calc(8px * var(--density)) 12px",
            background: "var(--accent)",
            color: "var(--accent-fg)",
            border: "1px solid transparent",
            borderRadius: "var(--radius-md)",
            fontWeight: 800,
            fontSize: 13,
            cursor: "pointer",
            boxShadow: "var(--shadow-sm)",
            transition: ".16s ease",
          }}
        >
          + New Venture
        </button>
      </div>
    </div>
  );
}
