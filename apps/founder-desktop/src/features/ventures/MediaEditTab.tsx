/**
 * MediaEditTab -- desktop UI for the MEDIA_EDIT_READY stage.
 *
 * Slice 5a of the media-edit arc. Surfaces the MediaEditStageRunner
 * for opt-in ventures. The stage is OPTIONAL: when
 * manifest.mediaEdit.enabled !== true, the runner is skipped and
 * LAUNCH reads the raw launch-reel.mp4 from MEDIA_READY.
 *
 * Provider selection (this slice):
 *   - engine = "config_only" -> real provider (no node deps; runs
 *     fully in the webview). The runner takes the real path,
 *     produces a synthetic receipt pointing at the raw reel.
 *   - engine = "opencut" -> SKELETAL fallback. The webview cannot
 *     spawn `bun dev` (PM-split rule). Slice 5b wires Tauri commands
 *     (media_edit_probe_vendor / media_edit_serve / media_edit_kill /
 *     media_edit_open_browser) and injects a Tauri-backed
 *     MediaEditProvider; until then run-media-edit-stage.ts falls
 *     through to provider=undefined so the runner's slice-3 skeletal
 *     path fires (writes a checkpoint and exits).
 *
 * UI shape (mirrors MediaTab / CrmTab / BackendTab):
 *   - Failed-run banner at top when a previous run left a dump
 *   - Enable toggle (manifest.mediaEdit.enabled)
 *   - Engine selector (opencut | config_only)
 *   - Port override (only when engine = opencut)
 *   - "Run media-edit stage" button
 *   - 5-state status pill: idle / running / skeletal / config-only / failed
 *   - Latest run summary
 *   - Artifact links (clip-manifest.md when written, final-reel.mp4 when
 *     present, edit-receipt.json when written)
 */
import type { FailedRunEntry, Venture, VentureManifest } from "@founder-os/domain";
import type { MediaEditEngine } from "@founder-os/media-edit-core";
import {
  getClipManifestPath,
  getEditReceiptPath,
  getEditedReelPath,
} from "@founder-os/workspace-core";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { findLatestFailedRunForStage } from "../../lib/failed-runs.js";
import { runMediaEditStage } from "../../lib/run-media-edit-stage.js";
import { pushToast } from "../../lib/toasts.js";
import { writeVentureManifest } from "../../lib/venture-io.js";
import { FailedRunBanner } from "./FailedRunBanner.js";

type Props = {
  venture: Venture;
  manifest: VentureManifest | null;
  onManifestUpdate?: (next: VentureManifest) => void;
};

type PillKind = "idle" | "running" | "skeletal" | "config-only" | "exported" | "failed";

type LastRun = {
  kind: "ran" | "skipped";
  success: boolean;
  mode: "skeletal" | "config_only" | "opencut";
  reviewGate: boolean;
  reason?: string;
};

export function MediaEditTab({ venture, manifest, onManifestUpdate }: Props) {
  const [running, setRunning] = useState(false);
  const [failedRun, setFailedRun] = useState<FailedRunEntry | null>(null);
  const [lastRun, setLastRun] = useState<LastRun | null>(null);
  const [manifestPreview, setManifestPreview] = useState<string | null>(null);
  const [reelExists, setReelExists] = useState(false);
  const [receiptExists, setReceiptExists] = useState(false);

  // Pull failed-run + artifact previews on mount and after each run.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps intentionally omitted
  useEffect(() => {
    let cancelled = false;
    findLatestFailedRunForStage(venture.rootPath, "MEDIA_EDIT")
      .then((entry) => {
        if (!cancelled) setFailedRun(entry);
      })
      .catch(() => {
        if (!cancelled) setFailedRun(null);
      });
    refreshArtifacts(venture).then((out) => {
      if (cancelled) return;
      setManifestPreview(out.manifest);
      setReelExists(out.reel);
      setReceiptExists(out.receipt);
    });
    return () => {
      cancelled = true;
    };
  }, [venture.id]);

  const enabled = manifest?.mediaEdit?.enabled === true;
  const engine: MediaEditEngine = manifest?.mediaEdit?.engine ?? "opencut";
  const serverPort = manifest?.mediaEdit?.serverPort ?? 3000;

  const handleRunMediaEditStage = async () => {
    if (running) return;
    if (!manifest) {
      pushToast({
        kind: "warn",
        message: "Venture manifest hasn't loaded yet -- try again in a moment",
        ttlMs: 5000,
      });
      return;
    }
    if (!enabled) {
      pushToast({
        kind: "warn",
        message: "Media-edit is not enabled for this venture",
        detail: "Flip the Enable toggle above to opt in.",
        ttlMs: 5000,
      });
      return;
    }
    setRunning(true);
    try {
      const out = await runMediaEditStage({ venture, manifest });
      if (out.kind === "skipped") {
        setLastRun({
          kind: "skipped",
          success: true,
          mode: "skeletal",
          reviewGate: false,
          reason: out.reason,
        });
        pushToast({
          kind: "info",
          message: "Media-edit stage skipped",
          detail: out.reason,
          ttlMs: 4000,
        });
      } else {
        const success = out.result.success;
        const mode = out.mode;
        const reviewGate = out.result.requiresReview;
        setLastRun({ kind: "ran", success, mode, reviewGate });
        if (!success) {
          pushToast({
            kind: "error",
            message: "Media-edit stage failed",
            detail: out.result.error?.message ?? "Unknown error",
          });
        } else if (mode === "opencut") {
          pushToast({
            kind: "success",
            message: "Media-edit stage complete (OpenCut)",
            detail: "Polished reel saved to 10_media/exports/edited/.",
            ttlMs: 5000,
          });
        } else if (mode === "config_only") {
          pushToast({
            kind: "success",
            message: "Media-edit stage complete (config_only)",
            detail: "LAUNCH will use the raw MEDIA_READY reel.",
            ttlMs: 5000,
          });
        }
      }
      const refreshed = await refreshArtifacts(venture);
      setManifestPreview(refreshed.manifest);
      setReelExists(refreshed.reel);
      setReceiptExists(refreshed.receipt);
      const next = await findLatestFailedRunForStage(venture.rootPath, "MEDIA_EDIT").catch(() => null);
      setFailedRun(next);
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Couldn't run media-edit stage",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRunning(false);
    }
  };

  const persistMediaEditConfig = async (next: {
    enabled?: boolean;
    engine?: MediaEditEngine;
    serverPort?: number;
  }) => {
    if (!manifest) return;
    try {
      const updated: VentureManifest = {
        ...manifest,
        mediaEdit: {
          ...(manifest.mediaEdit ?? {}),
          ...next,
        },
      };
      await writeVentureManifest(venture.rootPath, updated);
      onManifestUpdate?.(updated);
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Couldn't save media-edit config",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const pill: PillKind = derivePill(running, lastRun, reelExists);
  const clipPath = getClipManifestPath(venture.rootPath);
  const reelPath = getEditedReelPath(venture.rootPath);
  const receiptPath = getEditReceiptPath(venture.rootPath);

  return (
    <div
      style={{
        padding: 28,
        display: "flex",
        flexDirection: "column",
        gap: 20,
        height: "100%",
        overflowY: "auto",
        boxSizing: "border-box",
      }}
    >
      {failedRun && (
        <FailedRunBanner
          label="Media-edit"
          entry={failedRun}
          ventureRoot={venture.rootPath}
          busy={running}
          disabled={!manifest}
          onRetry={handleRunMediaEditStage}
        />
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>
            Media edit
          </h2>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-tertiary)" }}>
            Optional polish step. Drop OpenCut output under <code>10_media/exports/edited/</code>.
          </p>
        </div>
        <button
          type="button"
          onClick={handleRunMediaEditStage}
          disabled={running || !manifest || !enabled}
          title={
            !enabled
              ? "Flip the Enable toggle to opt in"
              : "Run MediaEditStageRunner -- workspace -> launch -> await export"
          }
          style={{
            padding: "8px 14px",
            background: running ? "var(--bg-elevated)" : "var(--accent-soft)",
            border: `1px solid ${running ? "var(--border-subtle)" : "var(--accent-soft)"}`,
            color: running || !enabled ? "var(--text-muted)" : "var(--accent-hover)",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            cursor: running || !enabled || !manifest ? "default" : "pointer",
          }}
        >
          {running ? "Running media-edit stage..." : "Run media-edit stage"}
        </button>
      </div>

      <ConfigPanel
        enabled={enabled}
        engine={engine}
        serverPort={serverPort}
        disabled={!manifest}
        onChange={persistMediaEditConfig}
      />

      <StatusPill pill={pill} mode={lastRun?.mode} reviewGate={lastRun?.reviewGate ?? false} />

      {manifestPreview && (
        <div
          style={{
            padding: 16,
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 8,
          }}
        >
          <h3 style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 700 }}>
            Clip manifest preview
          </h3>
          <p style={{ margin: "0 0 8px", fontSize: 11, color: "var(--text-tertiary)" }}>
            <code>{clipPath}</code>
          </p>
          <pre
            style={{
              margin: 0,
              fontSize: 12,
              color: "var(--text-secondary)",
              whiteSpace: "pre-wrap",
              maxHeight: 320,
              overflow: "auto",
            }}
          >
            {manifestPreview}
          </pre>
        </div>
      )}

      {(reelExists || receiptExists) && (
        <div
          style={{
            padding: 14,
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 8,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {reelExists && (
            <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              Edited reel: <code>{reelPath}</code>
            </span>
          )}
          {receiptExists && (
            <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              Receipt: <code>{receiptPath}</code>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function ConfigPanel({
  enabled,
  engine,
  serverPort,
  disabled,
  onChange,
}: {
  enabled: boolean;
  engine: MediaEditEngine;
  serverPort: number;
  disabled: boolean;
  onChange: (next: { enabled?: boolean; engine?: MediaEditEngine; serverPort?: number }) => void;
}) {
  return (
    <div
      style={{
        padding: 14,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 12, fontWeight: 700, color: "var(--text-secondary)" }}>
        Config
      </h3>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 12,
          color: disabled ? "var(--text-muted)" : "var(--text-primary)",
          cursor: disabled ? "default" : "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
          style={{ cursor: disabled ? "default" : "pointer" }}
        />
        <span style={{ fontWeight: 600 }}>Enable media-edit stage</span>
        <span style={{ color: "var(--text-tertiary)", fontSize: 11 }}>
          (when off, MEDIA_EDIT is skipped and LAUNCH uses the raw reel)
        </span>
      </label>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          opacity: enabled ? 1 : 0.5,
          pointerEvents: enabled ? "auto" : "none",
        }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
          <span style={{ fontWeight: 600 }}>Engine:</span>
          <select
            value={engine}
            disabled={disabled || !enabled}
            onChange={(e) => onChange({ engine: e.target.value as MediaEditEngine })}
            style={{
              padding: "4px 8px",
              border: "1px solid var(--border-subtle)",
              borderRadius: 4,
              background: "var(--bg-elevated)",
              color: "var(--text-primary)",
              fontSize: 12,
            }}
          >
            <option value="opencut">OpenCut (self-hosted)</option>
            <option value="config_only">Skip edit (ship raw reel)</option>
          </select>
        </label>

        {engine === "opencut" && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            <span style={{ fontWeight: 600 }}>Port:</span>
            <input
              type="number"
              min={1024}
              max={65535}
              value={serverPort}
              disabled={disabled || !enabled}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                if (Number.isFinite(n) && n > 0) onChange({ serverPort: n });
              }}
              style={{
                width: 80,
                padding: "4px 8px",
                border: "1px solid var(--border-subtle)",
                borderRadius: 4,
                background: "var(--bg-elevated)",
                color: "var(--text-primary)",
                fontSize: 12,
              }}
            />
          </label>
        )}
      </div>
    </div>
  );
}

function StatusPill({
  pill,
  mode,
  reviewGate,
}: {
  pill: PillKind;
  mode: LastRun["mode"] | undefined;
  reviewGate: boolean;
}) {
  const label =
    pill === "idle"
      ? "Idle"
      : pill === "running"
        ? "Running..."
        : pill === "skeletal"
          ? "Skeletal (OpenCut wiring -> slice 5b)"
          : pill === "config-only"
            ? "config_only ran -- raw reel ships"
            : pill === "exported"
              ? "Polished reel ready"
              : "Failed";
  const ok = pill === "config-only" || pill === "exported";
  const warn = pill === "skeletal" || reviewGate;
  return (
    <span
      style={{
        padding: "4px 10px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        background: ok ? "var(--accent-soft)" : "var(--bg-elevated)",
        color: ok ? "var(--accent-hover)" : warn ? "var(--text-secondary)" : "var(--text-muted)",
        border: `1px solid ${ok ? "var(--accent-soft)" : "var(--border-subtle)"}`,
        alignSelf: "flex-start",
      }}
    >
      {label}
      {mode && pill !== "idle" && pill !== "running" ? ` -- ${mode}` : ""}
    </span>
  );
}

function derivePill(
  running: boolean,
  lastRun: LastRun | null,
  reelExists: boolean,
): PillKind {
  if (running) return "running";
  if (!lastRun) return reelExists ? "exported" : "idle";
  if (!lastRun.success) return "failed";
  if (lastRun.mode === "config_only") return "config-only";
  if (lastRun.mode === "opencut") return "exported";
  if (reelExists) return "exported";
  return "idle";
}

async function refreshArtifacts(
  venture: Venture,
): Promise<{ manifest: string | null; reel: boolean; receipt: boolean }> {
  const clipPath = getClipManifestPath(venture.rootPath);
  const reelPath = getEditedReelPath(venture.rootPath);
  const receiptPath = getEditReceiptPath(venture.rootPath);
  const [manifest, reel, receipt] = await Promise.all([
    invoke<string>("read_file", { path: clipPath }).catch(() => null),
    invoke<boolean>("path_exists", { path: reelPath }).catch(() => false),
    invoke<boolean>("path_exists", { path: receiptPath }).catch(() => false),
  ]);
  return { manifest, reel, receipt };
}
