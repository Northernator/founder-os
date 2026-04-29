import type { VentureStage } from "@founder-os/domain";
import { VENTURE_STAGE_ORDER } from "@founder-os/domain";
import React from "react";

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
      {/* Header */}
      <div
        style={{
          padding: "16px",
          borderBottom: "1px solid var(--border-subtle)",
          fontWeight: 700,
          fontSize: 15,
          color: "var(--text-primary)",
        }}
      >
        Founder OS
      </div>

      {/* Ventures list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
        {ventures.map((v) => (
          <button
            key={v.id}
            onClick={() => onSelectVenture?.(v.id)}
            style={{
              width: "100%",
              display: "flex",
              flexDirection: "column",
              padding: "10px 16px",
              background: v.id === activeVentureId ? "var(--bg-selected)" : "transparent",
              color: "var(--text-primary)",
              border: "none",
              cursor: "pointer",
              textAlign: "left",
              borderLeft:
                v.id === activeVentureId
                  ? "3px solid var(--accent)"
                  : "3px solid transparent",
              transition: "background 0.15s",
            }}
          >
            <span style={{ fontWeight: 600, fontSize: 13, color: "var(--text-secondary)" }}>
              {v.name}
            </span>
            <span style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
              {STAGE_EMOJI[v.stage] ?? "•"} {v.stage.replace(/_/g, " ")}
            </span>
          </button>
        ))}
      </div>

      {/* New venture button */}
      <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border-subtle)" }}>
        <button
          onClick={onNewVenture}
          style={{
            width: "100%",
            padding: "8px",
            background: "var(--accent)",
            color: "var(--accent-fg)",
            border: "none",
            borderRadius: 6,
            fontWeight: 600,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          + New Venture
        </button>
      </div>
    </div>
  );
}
