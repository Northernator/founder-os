/**
 * CrmTab -- guided UI for the CRM_READY stage (slice 5a of CRM arc).
 *
 * The runner orchestrates 3 steps (provision, seed, campaign-template).
 * In slice 5a the WebView injects only the config_only provider; slice 5b
 * wires Tauri probes for Docker + bench. Until then, every run writes
 * JSON exports under 11_crm/ and never calls HTTP.
 *
 * UI shape (mirrors MediaTab):
 *  - Failed-run banner at top (gridSpan when there's a stale failure)
 *  - "Run CRM stage" button + status pills (provision / seed / campaign /
 *    checkpoint from deriveSteps)
 *  - "Local stack status" row: Docker / Bench / Config-only (slice 5b
 *    replaces with real probe data)
 *  - EnginesRow checkboxes that persist to venture.yaml
 *  - Engine pill: which engine the last run resolved to
 *  - Counts row: segments / contacts / opportunities upserted
 *  - "Open Frappe CRM" link when the resolved engine has a siteUrl
 */
import type {
  FailedRunEntry,
  Venture,
  VentureManifest,
} from "@founder-os/domain";
import type { CrmEngine } from "@founder-os/crm-core";
import { CRM_PROVIDER_CAPABILITIES } from "@founder-os/crm-providers";
import { useEffect, useState } from "react";

import { findLatestFailedRunForStage } from "../../lib/failed-runs.js";
import { runCrmStage } from "../../lib/run-crm-stage.js";
import type {
  CrmEngineStatus,
  RunCrmStageResult,
} from "../../lib/run-crm-stage.js";
import { pushToast } from "../../lib/toasts.js";
import { writeVentureManifest } from "../../lib/venture-io.js";
import { FailedRunBanner } from "./FailedRunBanner.js";

type Props = {
  venture: Venture;
  manifest: VentureManifest | null;
  onManifestUpdate?: (next: VentureManifest) => void;
};

type StepStatus = "ok" | "missing";

type LastRun = {
  steps: {
    provision: StepStatus;
    seed: StepStatus;
    campaign: StepStatus;
    checkpoint: StepStatus;
  };
  engineUsed: CrmEngine | "unknown";
  dockerStatus: CrmEngineStatus;
  benchStatus: CrmEngineStatus;
  generationSource: RunCrmStageResult["generationSource"];
  llmConfigured: boolean;
  counts: RunCrmStageResult["counts"];
};

const DEFAULT_TIERS: CrmEngine[] = ["frappe_docker", "frappe_bench", "config_only"];

export function CrmTab({ venture, manifest, onManifestUpdate }: Props) {
  const [running, setRunning] = useState(false);
  const [failedRun, setFailedRun] = useState<FailedRunEntry | null>(null);
  const [lastRun, setLastRun] = useState<LastRun | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps intentionally omitted
  useEffect(() => {
    let cancelled = false;
    findLatestFailedRunForStage(venture.rootPath, "CRM")
      .then((entry) => {
        if (!cancelled) setFailedRun(entry);
      })
      .catch(() => {
        if (!cancelled) setFailedRun(null);
      });
    return () => {
      cancelled = true;
    };
  }, [venture.rootPath]);

  async function handleRun() {
    if (!manifest) return;
    setRunning(true);
    try {
      const res = await runCrmStage({ venture, manifest });
      setLastRun({
        steps: res.steps,
        engineUsed: res.engineUsed,
        dockerStatus: res.dockerStatus,
        benchStatus: res.benchStatus,
        generationSource: res.generationSource,
        llmConfigured: res.llmConfigured,
        counts: res.counts,
      });
      if (res.result.success) {
        pushToast({
          kind: res.result.requiresReview ? "info" : "success",
          message: res.result.requiresReview
            ? "CRM stage ran -- review gate pending"
            : "CRM stage complete",
        });
      } else {
        pushToast({
          kind: "error",
          message: "CRM stage failed",
          detail: res.result.error?.message ?? "unknown",
        });
      }
      const updated = await findLatestFailedRunForStage(venture.rootPath, "CRM");
      setFailedRun(updated);
    } catch (err) {
      pushToast({
        kind: "error",
        message: "CRM stage threw",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRunning(false);
    }
  }

  async function toggleEngine(engine: CrmEngine, on: boolean) {
    if (!manifest) return;
    const currentTiers = manifest.crm?.engineTiers ?? DEFAULT_TIERS;
    const next: CrmEngine[] = on
      ? Array.from(new Set<CrmEngine>([...currentTiers, engine])) // preserve insertion order
      : currentTiers.filter((e) => e !== engine);
    // config_only is the always-on fallback; refuse to remove it.
    const safe: CrmEngine[] = next.includes("config_only") ? next : [...next, "config_only"];
    const nextManifest: VentureManifest = {
      ...manifest,
      crm: {
        adminEmail: manifest.crm?.adminEmail ?? "founder@example.com",
        engineTiers: safe,
        ...(manifest.crm?.docker !== undefined ? { docker: manifest.crm.docker } : {}),
        ...(manifest.crm?.bench !== undefined ? { bench: manifest.crm.bench } : {}),
        seeding: manifest.crm?.seeding ?? {
          importResearchContacts: false,
          secondaryIcpSegments: true,
          autoSendLaunchCampaign: false,
        },
      },
    };
    await writeVentureManifest(venture.rootPath, nextManifest);
    onManifestUpdate?.(nextManifest);
  }

  const tiers = manifest?.crm?.engineTiers ?? DEFAULT_TIERS;

  return (
    <div
      style={{
        display: "grid",
        gap: 16,
        padding: 16,
        height: "100%",
        overflowX: "hidden",
        overflowY: "auto",
        minWidth: 0,
        boxSizing: "border-box",
      }}
    >
      {failedRun ? (
        <FailedRunBanner
          label="CRM"
          entry={failedRun}
          ventureRoot={venture.rootPath}
          busy={running}
          onRetry={handleRun}
          onDismissed={() => setFailedRun(null)}
          gridSpan
        />
      ) : null}

      <section style={{ display: "grid", gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>CRM</h2>
        <p style={{ margin: 0, color: "#555", fontSize: 13 }}>
          Local-only. Frappe CRM via Docker on your machine, native bench, or
          JSON-only fallback. Nothing leaves the box -- the HTTP client guard
          enforces it at the code level.
        </p>
      </section>

      <section style={{ display: "grid", gap: 6 }}>
        <h3 style={{ margin: 0, fontSize: 14, color: "#555" }}>Engines</h3>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {CRM_PROVIDER_CAPABILITIES.map((cap) => (
            <label
              key={cap.engine}
              style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}
            >
              <input
                type="checkbox"
                checked={tiers.includes(cap.engine)}
                disabled={cap.engine === "config_only"}
                onChange={(e) => toggleEngine(cap.engine, e.target.checked)}
              />
              <span>
                <strong>{cap.label}</strong>{" "}
                <span style={{ color: "#888" }}>-- {cap.description}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section style={{ display: "grid", gap: 6 }}>
        <h3 style={{ margin: 0, fontSize: 14, color: "#555" }}>Local stack status</h3>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13 }}>
          <StatusPill label="Docker" status={lastRun?.dockerStatus ?? "disabled"} />
          <StatusPill label="Bench" status={lastRun?.benchStatus ?? "disabled"} />
          <StatusPill label="Config-only" status="ready" />
        </div>
      </section>

      <section style={{ display: "grid", gap: 8 }}>
        <button
          type="button"
          onClick={handleRun}
          disabled={running || !manifest}
          style={{
            padding: "8px 12px",
            background: "#3730A3",
            color: "white",
            border: "none",
            borderRadius: 4,
            fontSize: 14,
            cursor: running || !manifest ? "not-allowed" : "pointer",
            opacity: running || !manifest ? 0.6 : 1,
            justifySelf: "start",
          }}
        >
          {running ? "Running..." : "Run CRM stage"}
        </button>

        {lastRun ? (
          <div style={{ display: "grid", gap: 6 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 13 }}>
              <StepPill label="Provision" status={lastRun.steps.provision} />
              <StepPill label="Seed" status={lastRun.steps.seed} />
              <StepPill label="Campaign" status={lastRun.steps.campaign} />
              <StepPill label="Checkpoint" status={lastRun.steps.checkpoint} />
            </div>
            <div style={{ fontSize: 13, color: "#555" }}>
              Engine: <strong>{lastRun.engineUsed}</strong> · Templates:{" "}
              <strong>{lastRun.generationSource}</strong>
              {" · "}LLM:{" "}
              <strong>{lastRun.llmConfigured ? "configured" : "off"}</strong>
            </div>
            <div style={{ fontSize: 13, color: "#555" }}>
              Segments: <strong>{lastRun.counts.segments}</strong> · Contacts:{" "}
              <strong>{lastRun.counts.contacts}</strong> · Opportunities:{" "}
              <strong>{lastRun.counts.opportunities}</strong>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function StepPill({ label, status }: { label: string; status: StepStatus }) {
  const bg = status === "ok" ? "#D1FAE5" : "#FEE2E2";
  const text = status === "ok" ? "#065F46" : "#7F1D1D";
  return (
    <span
      style={{
        padding: "2px 8px",
        borderRadius: 12,
        background: bg,
        color: text,
        fontSize: 12,
      }}
    >
      {label}: {status}
    </span>
  );
}

function StatusPill({ label, status }: { label: string; status: CrmEngineStatus }) {
  const palette: Record<CrmEngineStatus, { bg: string; text: string }> = {
    ready: { bg: "#D1FAE5", text: "#065F46" },
    "not-detected": { bg: "#F3F4F6", text: "#374151" },
    "probe-failed": { bg: "#FEE2E2", text: "#7F1D1D" },
    disabled: { bg: "#F3F4F6", text: "#9CA3AF" },
    "config-only": { bg: "#E0E7FF", text: "#3730A3" },
  };
  const { bg, text } = palette[status];
  return (
    <span
      style={{
        padding: "2px 8px",
        borderRadius: 12,
        background: bg,
        color: text,
        fontSize: 12,
      }}
    >
      {label}: {status}
    </span>
  );
}
