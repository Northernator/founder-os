import type { Venture, VentureManifest } from "@founder-os/domain";
import type React from "react";
import { useState } from "react";
import { runHandoffPackStage, type RunHandoffPackStageResult } from "../../lib/run-handoff-pack-stage.js";
import { pushToast } from "../../lib/toasts.js";
import { joinPath, openInFileManager, writeVentureManifest } from "../../lib/venture-io.js";

type Props = {
  venture: Venture;
  manifest: VentureManifest | null;
  onManifestUpdate?: (manifest: VentureManifest) => void;
};

type Role = NonNullable<NonNullable<VentureManifest["handoffPack"]>["includeRolePacks"]>[number];
type Tier = NonNullable<NonNullable<VentureManifest["handoffPack"]>["excludeTiers"]>[number];
type HandoffPackConfig = NonNullable<VentureManifest["handoffPack"]> & {
  includeRolePacks: Role[];
  excludeTiers: Tier[];
};

const DEFAULT_ROLE_PACK_NAMES: Role[] = [
  "founder",
  "dev",
  "designer",
  "marketing",
  "sales",
  "support",
  "finance",
  "contractor",
];

const TIERS: Tier[] = ["A", "B", "C", "D"];

function readConfig(manifest: VentureManifest | null): HandoffPackConfig {
  const cfg = manifest?.handoffPack;
  return {
    enabled: cfg?.enabled ?? true,
    includeRolePacks: cfg?.includeRolePacks ?? [...DEFAULT_ROLE_PACK_NAMES],
    customCoverNote: cfg?.customCoverNote ?? "",
    excludeTiers: cfg?.excludeTiers ?? [],
  };
}

export function HandoffPackTab({ venture, manifest, onManifestUpdate }: Props) {
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<RunHandoffPackStageResult | null>(null);
  const cfg = readConfig(manifest);

  async function saveConfig(next: HandoffPackConfig) {
    if (!manifest) return;
    const nextManifest = { ...manifest, handoffPack: next } as VentureManifest;
    await writeVentureManifest(venture.rootPath, nextManifest);
    onManifestUpdate?.(nextManifest);
  }

  async function toggleRole(role: Role, on: boolean) {
    const current = new Set(cfg.includeRolePacks);
    if (on) current.add(role);
    else current.delete(role);
    await saveConfig({ ...cfg, includeRolePacks: [...current] });
  }

  async function toggleTier(tier: Tier, excluded: boolean) {
    const current = new Set(cfg.excludeTiers);
    if (excluded) current.add(tier);
    else current.delete(tier);
    await saveConfig({ ...cfg, excludeTiers: [...current] });
  }

  async function runPack() {
    if (!manifest) return;
    setRunning(true);
    try {
      const out = await runHandoffPackStage({ venture, manifest, force: true });
      setLastRun(out);
      pushToast({
        kind: out.result.success ? "success" : "error",
        message: out.result.success ? "Handoff pack rendered" : "Handoff pack failed",
        detail: out.result.success
          ? `${out.counts.docsRendered} docs, ${out.counts.rolePacksGenerated} role packs`
          : out.result.error?.message,
      });
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Handoff pack threw",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: 16, boxSizing: "border-box" }}>
      <div style={{ display: "grid", gap: 16, maxWidth: 980 }}>
        <section style={panelStyle}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 18 }}>Handoff Pack</h2>
              <p style={{ margin: "6px 0 0", color: "#6B7280", fontSize: 13 }}>
                Branded PDFs, role packs, and inventory under 13_handoff_pack.
              </p>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <button type="button" onClick={() => openInFileManager(joinPath(venture.rootPath, "13_handoff_pack"))} style={secondaryButton}>
                Open folder
              </button>
              <button type="button" onClick={runPack} disabled={running || cfg.enabled === false} style={primaryButton}>
                {running ? "Running..." : "Run handoff pack"}
              </button>
            </div>
          </div>
        </section>

        <section style={panelStyle}>
          <h3 style={headingStyle}>Config</h3>
          <label style={rowStyle}>
            <input
              type="checkbox"
              checked={cfg.enabled}
              onChange={(e) => saveConfig({ ...cfg, enabled: e.currentTarget.checked })}
            />
            Enable HANDOFF_PACK stage
          </label>

          <div style={{ marginTop: 16 }}>
            <div style={labelStyle}>Exclude tiers</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {TIERS.map((tier) => (
                <label key={tier} style={pillStyle}>
                  <input
                    type="checkbox"
                    checked={cfg.excludeTiers.includes(tier)}
                    onChange={(e) => toggleTier(tier, e.currentTarget.checked)}
                  />
                  Tier {tier}
                </label>
              ))}
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
            <label style={labelStyle} htmlFor="handoff-pack-cover-note">Footer note</label>
            <input
              id="handoff-pack-cover-note"
              value={cfg.customCoverNote}
              onChange={(e) => saveConfig({ ...cfg, customCoverNote: e.currentTarget.value })}
              placeholder="Confidential -- internal use only"
              style={{
                width: "100%",
                boxSizing: "border-box",
                border: "1px solid #E5E7EB",
                borderRadius: 6,
                padding: "9px 10px",
                fontSize: 13,
              }}
            />
          </div>
        </section>

        <section style={panelStyle}>
          <h3 style={headingStyle}>Role Packs</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
            {DEFAULT_ROLE_PACK_NAMES.map((role) => (
              <label key={role} style={pillStyle}>
                <input
                  type="checkbox"
                  checked={cfg.includeRolePacks.includes(role)}
                  onChange={(e) => toggleRole(role, e.currentTarget.checked)}
                />
                {role}
              </label>
            ))}
          </div>
        </section>
        {lastRun && (
          <section style={panelStyle}>
            <h3 style={headingStyle}>Last Run</h3>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13 }}>
              <Status label="Brand" value={lastRun.steps.brand} />
              <Status label="Docs" value={lastRun.steps.docs} />
              <Status label="Role packs" value={lastRun.steps.rolePacks} />
              <Status label="Inventory" value={lastRun.steps.inventory} />
            </div>
            <p style={{ margin: "12px 0 0", color: "#374151", fontSize: 13 }}>
              {lastRun.counts.docsRendered} docs rendered, {lastRun.counts.rolePacksGenerated} role packs,
              {lastRun.counts.failed} failed.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}

function Status({ label, value }: { label: string; value: "ok" | "missing" }) {
  return (
    <span style={{ ...pillStyle, borderColor: value === "ok" ? "#BBF7D0" : "#FECACA" }}>
      {label}: {value}
    </span>
  );
}

const panelStyle: React.CSSProperties = {
  border: "1px solid #E5E7EB",
  borderRadius: 8,
  padding: 16,
  background: "#FFFFFF",
};

const headingStyle: React.CSSProperties = {
  margin: "0 0 12px",
  fontSize: 15,
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "#6B7280",
  marginBottom: 8,
  textTransform: "uppercase",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 13,
};

const pillStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  border: "1px solid #E5E7EB",
  borderRadius: 6,
  padding: "8px 10px",
  fontSize: 13,
  background: "#F9FAFB",
};

const primaryButton: React.CSSProperties = {
  border: "none",
  borderRadius: 6,
  padding: "9px 12px",
  background: "#6366F1",
  color: "#FFFFFF",
  fontWeight: 700,
  cursor: "pointer",
};

const secondaryButton: React.CSSProperties = {
  border: "1px solid #E5E7EB",
  borderRadius: 6,
  padding: "9px 12px",
  background: "#FFFFFF",
  color: "#374151",
  fontWeight: 700,
  cursor: "pointer",
};
