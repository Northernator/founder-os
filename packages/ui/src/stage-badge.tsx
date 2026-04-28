import React from "react";
import type { VentureStage } from "@founder-os/domain";

const STAGE_COLOURS: Record<VentureStage, { bg: string; text: string }> = {
  IDEA: { bg: "#FEF3C7", text: "#92400E" },
  RESEARCHED: { bg: "#DBEAFE", text: "#1E40AF" },
  VALIDATED: { bg: "#D1FAE5", text: "#065F46" },
  BRAND_READY: { bg: "#EDE9FE", text: "#5B21B6" },
  UK_SETUP_READY: { bg: "#E0F2FE", text: "#075985" },
  SPEC_READY: { bg: "#FCE7F3", text: "#9D174D" },
  WIREFRAME_READY: { bg: "#FEF9C3", text: "#713F12" },
  STITCH_READY: { bg: "#F0FDF4", text: "#14532D" },
  BUILD_READY: { bg: "#EFF6FF", text: "#1E3A8A" },
  AUDIT_READY: { bg: "#FFF7ED", text: "#9A3412" },
  LAUNCH_READY: { bg: "#ECFDF5", text: "#064E3B" },
  LIVE: { bg: "#6366F1", text: "#FFFFFF" },
};

export function StageBadge({ stage }: { stage: VentureStage }) {
  const colours = STAGE_COLOURS[stage] ?? { bg: "#F3F4F6", text: "#374151" };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 20,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.04em",
        background: colours.bg,
        color: colours.text,
        textTransform: "uppercase",
      }}
    >
      {stage.replace(/_/g, " ")}
    </span>
  );
}
