import React from "react";
import type { VentureStage } from "@founder-os/domain";
import { VENTURE_STAGE_ORDER } from "@founder-os/domain";

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
          borderBottom: "1px solid #E5E7EB",
          fontWeight: 700,
          fontSize: 15,
          color: "#111827",
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
              background: v.id === activeVentureId ? "#EEF2FF" : "transparent",
              border: "none",
              cursor: "pointer",
              textAlign: "left",
              borderLeft: v.id === activeVentureId ? "3px solid #6366F1" : "3px solid transparent",
              transition: "background 0.15s",
            }}
          >
            <span style={{ fontWeight: 600, fontSize: 13, color: "#1F2937" }}>
              {v.name}
            </span>
            <span style={{ fontSize: 11, color: "#6B7280", marginTop: 2 }}>
              {STAGE_EMOJI[v.stage] ?? "•"} {v.stage.replace(/_/g, " ")}
            </span>
          </button>
        ))}
      </div>

      {/* New venture button */}
      <div style={{ padding: "12px 16px", borderTop: "1px solid #E5E7EB" }}>
        <button
          onClick={onNewVenture}
          style={{
            width: "100%",
            padding: "8px",
            background: "#6366F1",
            color: "#FFFFFF",
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
