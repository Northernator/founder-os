/**
 * MediaTab -- guided UI for the MEDIA_READY stage.
 *
 * Slice 5a of the media arc. The runner orchestrates 4 steps (script,
 * storyboard, render-shots, stitch). In slice 5a no MediaProvider impls
 * are injected from the desktop, so every shot resolves to the
 * gemini_flow paste-in path: render-shots writes flow-prompts.md and
 * stitch is skipped until the founder pastes Flow output back into
 * 10_media/renders/ and re-runs.
 *
 * UI shape (mirrors UkSetupTab/ValidationTab but lighter -- no canvas):
 *  - Failed-run banner at top (gridSpan when there's a stale failure)
 *  - "Run media stage" button + status pills (script / storyboard /
 *    renders / stitch from deriveSteps)
 *  - Pending-flow CTA panel when applicable: opens flow-prompts.md
 *    explorer link + a "I've pasted the renders" re-run button
 *  - Latest media-script.md preview
 *  - Launch-reel.mp4 player + path link when stitched
 *
 * Saving model: this stage has no founder-editable canvas. The runner
 * is the single source of truth for the artifacts; the tab just runs
 * it and surfaces the receipt.
 */
import type { FailedRunEntry, Venture, VentureManifest } from "@founder-os/domain";
import {
  getFlowPromptsPath,
  getLaunchReelPath,
  getMediaScriptMdPath,
} from "@founder-os/workspace-core";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { findLatestFailedRunForStage } from "../../lib/failed-runs.js";
import { runMediaStage } from "../../lib/run-media-stage.js";
import { pushToast } from "../../lib/toasts.js";
import { FailedRunBanner } from "./FailedRunBanner.js";

type Props = {
  venture: Venture;
  manifest: VentureManifest | null;
};

type StepStatus = "ok" | "missing" | "pending-flow" | "skipped";

type LastRun = {
  steps: { script: StepStatus; storyboard: StepStatus; renderShots: StepStatus; stitch: StepStatus };
  generationSource: "llm" | "deterministic" | "deterministic-fallback" | "unknown";
  pendingFlow: boolean;
  llmConfigured: boolean;
  hfStatus: "ready" | "bootstrapped" | "not-detected" | "doctor-failed" | "bootstrap-failed";
};

export function MediaTab({ venture, manifest }: Props) {
  const [running, setRunning] = useState(false);
  const [failedRun, setFailedRun] = useState<FailedRunEntry | null>(null);
  const [lastRun, setLastRun] = useState<LastRun | null>(null);
  const [scriptPreview, setScriptPreview] = useState<string | null>(null);
  const [reelExists, setReelExists] = useState(false);

  // Pull failed-run + artifact preview on mount and after each run.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps intentionally omitted
  useEffect(() => {
    let cancelled = false;
    findLatestFailedRunForStage(venture.rootPath, "MEDIA")
      .then((entry) => {
        if (!cancelled) setFailedRun(entry);
      })
      .catch(() => {
        if (!cancelled) setFailedRun(null);
      });
    refreshArtifacts(venture).then(({ scriptMd, reel }) => {
      if (cancelled) return;
      setScriptPreview(scriptMd);
      setReelExists(reel);
    });
    return () => {
      cancelled = true;
    };
  }, [venture.id]);

  const handleRunMediaStage = async () => {
    if (running) return;
    if (!manifest) {
      pushToast({
        kind: "warn",
        message: "Venture manifest hasn't loaded yet -- try again in a moment",
        ttlMs: 5000,
      });
      return;
    }
    setRunning(true);
    try {
      const out = await runMediaStage({ venture, manifest });
      const { result, steps, generationSource, pendingFlow, llmConfigured, hfStatus } = out;
      setLastRun({ steps, generationSource, pendingFlow, llmConfigured, hfStatus });

      if (!result.success) {
        pushToast({
          kind: "error",
          message: "Media stage failed",
          detail: result.error?.message ?? "Unknown error",
        });
      } else if (hfStatus === "bootstrapped") {
        pushToast({
          kind: "info",
          message: "HyperFrames project bootstrapped",
          detail: "First-run setup complete. Future media runs will reuse 10_media/hyperframes/.",
          ttlMs: 6000,
        });
      }

      if (!result.success) {
        // already toasted above
      } else if (pendingFlow) {
        pushToast({
          kind: "info",
          message: "Media stage paused for Gemini Flow paste-in",
          detail: "Open flow-prompts.md, paste each shot into Flow, drop MP4s into 10_media/renders/, then re-run.",
          ttlMs: 8000,
        });
      } else {
        pushToast({
          kind: "success",
          message: `Media stage complete (${generationSource} script)${
            steps.stitch === "ok" ? " -- launch reel ready" : ""
          }`,
          detail: llmConfigured ? "" : "No LLM provider configured -- ran deterministic.",
          ttlMs: 5000,
        });
      }

      // Re-fetch artifacts so the preview/reel-exists chips reflect the run.
      const refreshed = await refreshArtifacts(venture);
      setScriptPreview(refreshed.scriptMd);
      setReelExists(refreshed.reel);
      // Re-pull failed-run -- successful runs clear it via the orchestrator.
      const next = await findLatestFailedRunForStage(venture.rootPath, "MEDIA").catch(() => null);
      setFailedRun(next);
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Couldn't run media stage",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRunning(false);
    }
  };

  const flowPromptsPath = getFlowPromptsPath(venture.rootPath);
  const reelPath = getLaunchReelPath(venture.rootPath);

  return (
    <div style={{ padding: 28, display: "flex", flexDirection: "column", gap: 20 }}>
      {failedRun && (
        <FailedRunBanner
          label="Media"
          entry={failedRun}
          ventureRoot={venture.rootPath}
          busy={running}
          disabled={!manifest}
          onRetry={handleRunMediaStage}
        />
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>
            Media
          </h2>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-tertiary)" }}>
            Script -&gt; storyboard -&gt; render -&gt; stitch. Saved under <code>10_media/</code>.
          </p>
        </div>
        <button
          type="button"
          onClick={handleRunMediaStage}
          disabled={running || !manifest}
          title="Run MediaStageRunner -- 4 steps (script, storyboard, render, stitch)"
          style={{
            padding: "8px 14px",
            background: running ? "var(--bg-elevated)" : "var(--accent-soft)",
            border: `1px solid ${running ? "var(--border-subtle)" : "var(--accent-soft)"}`,
            color: running ? "var(--text-muted)" : "var(--accent-hover)",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            cursor: running || !manifest ? "default" : "pointer",
          }}
        >
          {running ? "Running media stage..." : "Run media stage"}
        </button>
      </div>

      {lastRun && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <HfPill status={lastRun.hfStatus} />
          <StepPills steps={lastRun.steps} />
        </div>
      )}

      {lastRun?.pendingFlow && (
        <PendingFlowPanel
          flowPromptsPath={flowPromptsPath}
          onRerun={handleRunMediaStage}
          busy={running}
        />
      )}

      {scriptPreview && (
        <div
          style={{
            padding: 16,
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 8,
          }}
        >
          <h3 style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 700 }}>
            Latest script preview
          </h3>
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
            {scriptPreview}
          </pre>
        </div>
      )}

      {reelExists && (
        <div
          style={{
            padding: 14,
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            Launch reel ready: <code>{reelPath}</code>
          </span>
        </div>
      )}
    </div>
  );
}

function HfPill({ status }: { status: LastRun["hfStatus"] }) {
  const label =
    status === "ready"
      ? "HyperFrames: ready (auto-render)"
      : status === "bootstrapped"
        ? "HyperFrames: bootstrapped (auto-render)"
        : status === "not-detected"
          ? "HyperFrames: not detected -- install with `npm install -g hyperframes` for auto-render"
          : status === "doctor-failed"
            ? "HyperFrames: env check failed (Node 22+ + ffmpeg required)"
            : "HyperFrames: bootstrap failed (run `npx hyperframes init` manually under 10_media/hyperframes/)";
  const ok = status === "ready" || status === "bootstrapped";
  return (
    <span
      style={{
        padding: "4px 10px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        background: ok ? "var(--accent-soft)" : "var(--bg-elevated)",
        color: ok ? "var(--accent-hover)" : "var(--text-muted)",
        border: `1px solid ${ok ? "var(--accent-soft)" : "var(--border-subtle)"}`,
        alignSelf: "flex-start",
      }}
    >
      {label}
    </span>
  );
}

function StepPills({ steps }: { steps: LastRun["steps"] }) {
  const items: Array<{ label: string; status: StepStatus }> = [
    { label: "Script", status: steps.script },
    { label: "Storyboard", status: steps.storyboard },
    { label: "Renders", status: steps.renderShots },
    { label: "Stitch", status: steps.stitch },
  ];
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {items.map((item) => (
        <span
          key={item.label}
          style={{
            padding: "4px 10px",
            borderRadius: 999,
            fontSize: 11,
            fontWeight: 600,
            background: pillBg(item.status),
            color: pillFg(item.status),
            border: `1px solid ${pillBorder(item.status)}`,
          }}
        >
          {item.label}: {item.status}
        </span>
      ))}
    </div>
  );
}

function PendingFlowPanel({
  flowPromptsPath,
  onRerun,
  busy,
}: {
  flowPromptsPath: string;
  onRerun: () => void;
  busy: boolean;
}) {
  return (
    <div
      style={{
        padding: 16,
        background: "var(--bg-elevated)",
        border: "1px solid var(--accent-soft)",
        borderRadius: 8,
      }}
    >
      <h3 style={{ margin: "0 0 6px", fontSize: 13, fontWeight: 700, color: "var(--accent-hover)" }}>
        Paste-in queued: open Gemini Flow
      </h3>
      <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--text-secondary)" }}>
        The runner queued every shot for Flow paste-in (no local provider yet). Open{" "}
        <code>{flowPromptsPath}</code>, paste each section into Flow, save MP4s under{" "}
        <code>10_media/renders/&lt;sceneId&gt;.mp4</code>, then click below to resume.
      </p>
      <button
        type="button"
        onClick={onRerun}
        disabled={busy}
        style={{
          padding: "6px 12px",
          background: busy ? "var(--bg-elevated)" : "var(--accent-soft)",
          border: "1px solid var(--accent-soft)",
          color: busy ? "var(--text-muted)" : "var(--accent-hover)",
          borderRadius: 6,
          fontSize: 12,
          fontWeight: 600,
          cursor: busy ? "default" : "pointer",
        }}
      >
        {busy ? "Re-running..." : "I've pasted the renders -- re-run"}
      </button>
    </div>
  );
}

function pillBg(status: StepStatus): string {
  if (status === "ok") return "var(--accent-soft)";
  if (status === "pending-flow") return "var(--bg-elevated)";
  if (status === "skipped") return "var(--bg-elevated)";
  return "var(--bg-elevated)";
}
function pillFg(status: StepStatus): string {
  if (status === "ok") return "var(--accent-hover)";
  return "var(--text-muted)";
}
function pillBorder(status: StepStatus): string {
  if (status === "ok") return "var(--accent-soft)";
  return "var(--border-subtle)";
}

async function refreshArtifacts(venture: Venture): Promise<{ scriptMd: string | null; reel: boolean }> {
  const scriptMdPath = getMediaScriptMdPath(venture.rootPath);
  const reelPath = getLaunchReelPath(venture.rootPath);
  const [scriptMd, reel] = await Promise.all([
    invoke<string>("read_file", { path: scriptMdPath }).catch(() => null),
    invoke<boolean>("path_exists", { path: reelPath }).catch(() => false),
  ]);
  return { scriptMd, reel };
}
