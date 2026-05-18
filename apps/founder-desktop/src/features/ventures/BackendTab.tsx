/**
 * BackendTab -- guided UI for the BACKEND_READY stage (slice 5a of backend arc).
 *
 * The runner orchestrates 4 steps (provision, schema, hooks, export).
 * In slice 5a the WebView injects only the config_only provider; slice 5b
 * wires Tauri probes for the PocketBase binary. Until then, every run
 * writes JSON exports + an SDK trio under 12_backend/ and never spawns
 * the binary.
 *
 * UI shape (mirrors CrmTab):
 *  - Failed-run banner at top (gridSpan when there's a stale failure)
 *  - "Run backend stage" button + status pills (provision / schema /
 *    hooks / export / checkpoint from deriveSteps)
 *  - "Local stack status" row: PocketBase / Config-only (slice 5b
 *    replaces with real probe data)
 *  - EnginesRow checkboxes that persist to venture.yaml
 *  - Engine pill: which engine the last run resolved to
 *  - Counts row: collections applied / hooks generated / collection count
 */
import type {
  FailedRunEntry,
  Venture,
  VentureManifest,
} from "@founder-os/domain";
import type { BackendEngine } from "@founder-os/backend-core";
import { BACKEND_PROVIDER_CAPABILITIES } from "@founder-os/backend-providers";
import { useEffect, useState } from "react";

import { findLatestFailedRunForStage } from "../../lib/failed-runs.js";
import { probeSupabase } from "../../lib/backend-supabase.js";
import { runBackendStage } from "../../lib/run-backend-stage.js";
import type {
  BackendEngineStatus,
  RunBackendStageResult,
} from "../../lib/run-backend-stage.js";
import { pushToast } from "../../lib/toasts.js";
import { writeVentureManifest } from "../../lib/venture-io.js";
import { FailedRunBanner } from "./FailedRunBanner.js";
import { SupabaseCredentialsModal } from "./SupabaseCredentialsModal.js";

type Props = {
  venture: Venture;
  manifest: VentureManifest | null;
  onManifestUpdate?: (next: VentureManifest) => void;
};

type StepStatus = "ok" | "missing";

type LastRun = {
  steps: {
    provision: StepStatus;
    schema: StepStatus;
    hooks: StepStatus;
    export: StepStatus;
    checkpoint: StepStatus;
  };
  engineUsed: BackendEngine | "unknown";
  pocketbaseStatus: BackendEngineStatus;
  generationSource: RunBackendStageResult["generationSource"];
  llmConfigured: boolean;
  counts: RunBackendStageResult["counts"];
};

const DEFAULT_TIERS: BackendEngine[] = ["pocketbase", "drizzle_sqlite", "config_only"];

type BackendManifestSubset = {
  enabledEngines?: BackendEngine[];
  supabase?: {
    projectUrl?: string;
    anonKeyEnvVar?: string;
    serviceRoleKeyEnvVar?: string;
  };
};

function readBackendManifest(
  manifest: VentureManifest | null,
): BackendManifestSubset {
  if (!manifest) return {};
  return (
    (manifest as { backend?: BackendManifestSubset }).backend ?? {}
  );
}

export function BackendTab({ venture, manifest, onManifestUpdate }: Props) {
  const [running, setRunning] = useState(false);
  const [failedRun, setFailedRun] = useState<FailedRunEntry | null>(null);
  const [lastRun, setLastRun] = useState<LastRun | null>(null);
  const [showSupabaseModal, setShowSupabaseModal] = useState(false);
  const [supabaseStatus, setSupabaseStatus] = useState<BackendEngineStatus>(
    "not-detected",
  );

  const supabaseProjectUrl =
    readBackendManifest(manifest).supabase?.projectUrl ?? "";

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps intentionally omitted
  useEffect(() => {
    let cancelled = false;
    findLatestFailedRunForStage(venture.rootPath, "BACKEND")
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

  // Probe Supabase whenever projectUrl changes. supabase is "disabled"
  // when not in enabledEngines, "not-detected" when in tier list but no
  // projectUrl, "ready" when the probe round-trips cleanly, "probe-failed"
  // otherwise. Mirrors the PocketBase probe flow.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps intentionally omitted
  useEffect(() => {
    const cfg = readBackendManifest(manifest);
    const enabled = (cfg.enabledEngines ?? DEFAULT_TIERS).includes("supabase");
    if (!enabled) {
      setSupabaseStatus("disabled");
      return;
    }
    if (!supabaseProjectUrl) {
      setSupabaseStatus("not-detected");
      return;
    }
    let cancelled = false;
    probeSupabase({
      ventureRoot: venture.rootPath,
      projectUrl: supabaseProjectUrl,
      anonKeyEnvVar: cfg.supabase?.anonKeyEnvVar,
      serviceRoleKeyEnvVar: cfg.supabase?.serviceRoleKeyEnvVar,
    })
      .then((res) => {
        if (cancelled) return;
        setSupabaseStatus(res.available ? "ready" : "not-detected");
      })
      .catch(() => {
        if (!cancelled) setSupabaseStatus("probe-failed");
      });
    return () => {
      cancelled = true;
    };
  }, [venture.rootPath, supabaseProjectUrl, manifest]);

  async function handleSupabaseSaved(projectUrl: string) {
    if (!manifest) return;
    const current = readBackendManifest(manifest);
    const nextManifest = {
      ...manifest,
      backend: {
        ...current,
        supabase: {
          ...(current.supabase ?? {}),
          projectUrl,
        },
      },
    } as VentureManifest;
    await writeVentureManifest(venture.rootPath, nextManifest);
    onManifestUpdate?.(nextManifest);
    setShowSupabaseModal(false);
    setSupabaseStatus("ready");
    pushToast({ kind: "success", message: "Supabase connected" });
  }

  async function handleRun() {
    if (!manifest) return;
    setRunning(true);
    try {
      const res = await runBackendStage({ venture, manifest });
      setLastRun({
        steps: res.steps,
        engineUsed: res.engineUsed,
        pocketbaseStatus: res.pocketbaseStatus,
        generationSource: res.generationSource,
        llmConfigured: res.llmConfigured,
        counts: res.counts,
      });
      if (res.result.success) {
        pushToast({
          kind: res.result.requiresReview ? "info" : "success",
          message: res.result.requiresReview
            ? "Backend stage ran -- schema review pending"
            : "Backend stage complete",
        });
      } else {
        pushToast({
          kind: "error",
          message: "Backend stage failed",
          detail: res.result.error?.message ?? "unknown",
        });
      }
      const updated = await findLatestFailedRunForStage(venture.rootPath, "BACKEND");
      setFailedRun(updated);
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Backend stage threw",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRunning(false);
    }
  }

  async function toggleEngine(engine: BackendEngine, on: boolean) {
    if (!manifest) return;
    const current = readBackendManifest(manifest);
    const currentTiers = current.enabledEngines ?? DEFAULT_TIERS;
    const next: BackendEngine[] = on
      ? Array.from(new Set<BackendEngine>([...currentTiers, engine]))
      : currentTiers.filter((e) => e !== engine);
    // config_only is the always-on fallback; refuse to remove it.
    const safe: BackendEngine[] = next.includes("config_only")
      ? next
      : [...next, "config_only"];
    const nextManifest = {
      ...manifest,
      backend: {
        ...current,
        enabledEngines: safe,
      },
    } as VentureManifest;
    await writeVentureManifest(venture.rootPath, nextManifest);
    onManifestUpdate?.(nextManifest);
  }

  const tiers = readBackendManifest(manifest).enabledEngines ?? DEFAULT_TIERS;

  return (
    <div
      style={{
        display: "grid",
        gap: 16,
        padding: 16,
        height: "100%",
        overflowY: "auto",
        boxSizing: "border-box",
      }}
    >
      {failedRun ? (
        <FailedRunBanner
          label="Backend"
          entry={failedRun}
          ventureRoot={venture.rootPath}
          busy={running}
          onRetry={handleRun}
          onDismissed={() => setFailedRun(null)}
          gridSpan
        />
      ) : null}

      <section style={{ display: "grid", gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Backend</h2>
        <p style={{ margin: 0, color: "#555", fontSize: 13 }}>
          Local-first. Tier_0 PocketBase ships as a single binary on your
          machine -- auth + db + realtime + files, no account required.
          Hosted tiers (Supabase / Convex / Appwrite) are opt-in per
          venture.
        </p>
      </section>

      <section style={{ display: "grid", gap: 6 }}>
        <h3 style={{ margin: 0, fontSize: 14, color: "#555" }}>Engines</h3>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {BACKEND_PROVIDER_CAPABILITIES.map((cap) => (
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
          <StatusPill
            label="PocketBase"
            status={lastRun?.pocketbaseStatus ?? "not-detected"}
          />
          <StatusPill label="Config-only" status="ready" />
          <StatusPill label="Supabase" status={supabaseStatus} />
        </div>
      </section>

      {tiers.includes("supabase") ? (
        <section style={{ display: "grid", gap: 6 }}>
          <h3 style={{ margin: 0, fontSize: 14, color: "#555" }}>Supabase</h3>
          <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
            {supabaseProjectUrl ? (
              <span style={{ color: "#555" }}>
                Project URL: <code>{supabaseProjectUrl}</code>
              </span>
            ) : (
              <span style={{ color: "#888" }}>
                No project URL yet -- paste your Supabase credentials to enable.
              </span>
            )}
            <button
              type="button"
              onClick={() => setShowSupabaseModal(true)}
              style={{
                padding: "4px 10px",
                fontSize: 12,
                background: "#3730A3",
                color: "white",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              {supabaseProjectUrl ? "Update credentials" : "Connect Supabase"}
            </button>
          </div>
        </section>
      ) : null}

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
          {running ? "Running..." : "Run backend stage"}
        </button>

        {lastRun ? (
          <div style={{ display: "grid", gap: 6 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 13 }}>
              <StepPill label="Provision" status={lastRun.steps.provision} />
              <StepPill label="Schema" status={lastRun.steps.schema} />
              <StepPill label="Hooks" status={lastRun.steps.hooks} />
              <StepPill label="Export" status={lastRun.steps.export} />
              <StepPill label="Checkpoint" status={lastRun.steps.checkpoint} />
            </div>
            <div style={{ fontSize: 13, color: "#555" }}>
              Engine: <strong>{lastRun.engineUsed}</strong> · Hooks:{" "}
              <strong>{lastRun.generationSource}</strong>
              {" · "}LLM:{" "}
              <strong>{lastRun.llmConfigured ? "configured" : "off"}</strong>
            </div>
            <div style={{ fontSize: 13, color: "#555" }}>
              Collections applied: <strong>{lastRun.counts.collectionsApplied}</strong> ·
              Hooks generated: <strong>{lastRun.counts.hooksGenerated}</strong> ·
              Export collection count:{" "}
              <strong>{lastRun.counts.collectionCount}</strong>
            </div>
          </div>
        ) : null}
      </section>

      {showSupabaseModal ? (
        <SupabaseCredentialsModal
          ventureRoot={venture.rootPath}
          initialProjectUrl={supabaseProjectUrl}
          onSaved={handleSupabaseSaved}
          onClose={() => setShowSupabaseModal(false)}
        />
      ) : null}
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

function StatusPill({
  label,
  status,
}: {
  label: string;
  status: BackendEngineStatus;
}) {
  const palette: Record<BackendEngineStatus, { bg: string; text: string }> = {
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
