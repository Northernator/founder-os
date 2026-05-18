import {
  Background,
  Controls,
  type Edge,
  Handle,
  MiniMap,
  type Node,
  type NodeProps,
  type NodeTypes,
  Position,
  ReactFlow,
} from "@xyflow/react";
import type React from "react";
import { useMemo } from "react";
import "@xyflow/react/dist/style.css";
import { VENTURE_STAGE_ORDER, type VentureStage } from "@founder-os/domain";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────
export type StageNodeStatus = "complete" | "active" | "pending" | "blocked";

export type StageNodeData = {
  stage: VentureStage;
  status: StageNodeStatus;
  label: string;
  onClick?: (stage: VentureStage) => void;
};

// ──────────────────────────────────────────────
// Custom node
// ──────────────────────────────────────────────
const STATUS_COLOURS: Record<StageNodeStatus, { bg: string; border: string; text: string }> = {
  complete: { bg: "#D1FAE5", border: "#10B981", text: "#064E3B" },
  active: { bg: "#EEF2FF", border: "#6366F1", text: "#3730A3" },
  pending: { bg: "#F9FAFB", border: "#D1D5DB", text: "#6B7280" },
  blocked: { bg: "#FEF2F2", border: "#EF4444", text: "#991B1B" },
};

const STATUS_ICON: Record<StageNodeStatus, string> = {
  complete: "✓",
  active: "▶",
  pending: "○",
  blocked: "✕",
};

function StageNode({ data }: NodeProps) {
  const d = data as StageNodeData;
  const colours = STATUS_COLOURS[d.status];
  return (
    <div
      onClick={() => d.onClick?.(d.stage)}
      style={{
        background: colours.bg,
        border: `2px solid ${colours.border}`,
        borderRadius: 10,
        padding: "10px 16px",
        minWidth: 160,
        cursor: d.onClick ? "pointer" : "default",
        userSelect: "none",
        transition: "transform 0.1s",
        fontFamily: "Inter, sans-serif",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 22,
            height: 22,
            borderRadius: "50%",
            background: colours.border,
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {STATUS_ICON[d.status]}
        </span>
        <div>
          <div style={{ fontWeight: 700, fontSize: 12, color: colours.text }}>{d.label}</div>
          <div style={{ fontSize: 10, color: colours.text, opacity: 0.7 }}>
            {d.stage.replace(/_/g, " ")}
          </div>
        </div>
      </div>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

const NODE_TYPES: NodeTypes = { stageNode: StageNode };

// ──────────────────────────────────────────────
// Stage labels
// ──────────────────────────────────────────────
const STAGE_LABELS: Record<VentureStage, string> = {
  IDEA: "💡 Idea",
  RESEARCHED: "🔍 Research",
  VALIDATED: "✅ Validation",
  BRAND_READY: "🎨 Brand",
  UK_SETUP_READY: "🇬🇧 UK Setup",
  SPEC_READY: "📋 Spec",
  WIREFRAME_READY: "🖼️ Wireframes",
  STITCH_READY: "🧵 Stitch",
  BACKEND_READY: "🗄 Backend",
  BUILD_READY: "🔨 Build",
  AUDIT_READY: "🔒 Audit",
  LAUNCH_READY: "🚀 Launch",
  MEDIA_READY: "🎬 Media",
  MEDIA_EDIT_READY: "✂️ Polish",
  CRM_READY: "📇 CRM",
  HANDOFF_PACK_READY: "📦 Handoff Pack",
  LIVE: "🌍 Live",
};

// ──────────────────────────────────────────────
// StageGraph component
// ──────────────────────────────────────────────
export type StageGraphProps = {
  currentStage: VentureStage;
  blockedStages?: VentureStage[];
  onStageClick?: (stage: VentureStage) => void;
  style?: React.CSSProperties;
};

export function StageGraph({
  currentStage,
  blockedStages = [],
  onStageClick,
  style,
}: StageGraphProps) {
  const currentIdx = VENTURE_STAGE_ORDER.indexOf(currentStage);

  const nodes: Node[] = useMemo(
    () =>
      VENTURE_STAGE_ORDER.map((stage, i) => {
        let status: StageNodeStatus;
        if (blockedStages.includes(stage)) {
          status = "blocked";
        } else if (i < currentIdx) {
          status = "complete";
        } else if (i === currentIdx) {
          status = "active";
        } else {
          status = "pending";
        }

        // Lay out in 3 rows, 4 columns
        const col = i % 4;
        const row = Math.floor(i / 4);

        return {
          id: stage,
          type: "stageNode",
          position: { x: col * 210, y: row * 100 },
          data: {
            stage,
            status,
            label: STAGE_LABELS[stage],
            onClick: onStageClick,
          } satisfies StageNodeData,
        };
      }),
    [currentIdx, blockedStages, onStageClick]
  );

  const edges: Edge[] = useMemo(
    () =>
      VENTURE_STAGE_ORDER.slice(0, -1).map((stage, i) => ({
        id: `${stage}→${VENTURE_STAGE_ORDER[i + 1]}`,
        source: stage,
        target: VENTURE_STAGE_ORDER[i + 1] as string,
        animated: i === currentIdx,
        style: {
          stroke: i < currentIdx ? "#10B981" : "#D1D5DB",
          strokeWidth: 2,
        },
      })),
    [currentIdx]
  );

  return (
    <div style={{ height: 360, ...style }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls />
        <MiniMap />
      </ReactFlow>
    </div>
  );
}
