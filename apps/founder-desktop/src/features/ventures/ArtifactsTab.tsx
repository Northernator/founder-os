/**
 * Artifacts tab — scans the venture folder and lets you preview what the
 * pipeline produced. Two-pane layout: list on the left grouped by inferred
 * artifact type, preview pane on the right.
 *
 * Re-scans automatically when `rescanToken` changes — the dashboard bumps
 * that after a pipeline run completes, so freshly-written files appear
 * without the user having to click anything.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ScannedArtifact,
  readArtifactText,
  scanVentureArtifacts,
} from "../../lib/artifacts-scan.js";
import * as db from "../../lib/db.js";
import { pushToast } from "../../lib/toasts.js";
import { renderMarkdown } from "./markdown.js";

// Local error stringifier — matches the pattern used in db.ts and
// venture-io.ts. Inline to avoid a shared utils file for a 6-line helper.
function errDetail(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

type Props = {
  ventureId: string;
  ventureRoot: string;
  /** Bump this number to trigger a re-scan (e.g. after a pipeline run). */
  rescanToken?: number;
};

const PREVIEW_MAX_BYTES = 1_000_000; // 1MB — preview cuts off above this

export function ArtifactsTab({ ventureId, ventureRoot, rescanToken = 0 }: Props) {
  const [artifacts, setArtifacts] = useState<ScannedArtifact[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ScannedArtifact | null>(null);

  // Track the latest scan request so out-of-order async responses don't
  // overwrite a newer scan's results.
  const latestScanKey = useRef<string>("");

  const runScan = useCallback(async () => {
    const key = `${ventureId}@${Date.now()}`;
    latestScanKey.current = key;
    setScanning(true);
    setScanError(null);
    try {
      const found = await scanVentureArtifacts(ventureId, ventureRoot);
      if (latestScanKey.current !== key) return;
      setArtifacts(found);

      // Persist to DB in the background — don't block the UI on it. Failures
      // are logged but don't bubble to the user; the on-screen list is the
      // source of truth for this tab.
      void persistArtifacts(ventureId, found);

      // Drop selection if the selected file is no longer on disk.
      if (selected && !found.some((a) => a.absolutePath === selected.absolutePath)) {
        setSelected(null);
      }
    } catch (err) {
      if (latestScanKey.current !== key) return;
      console.error("[artifacts] scan failed", err);
      const msg = errDetail(err);
      // Sticky error toast — scan failure means the tab shows an empty
      // list with a small inline error. If the scan was bumped by a
      // pipeline run (rescanToken change), the user isn't necessarily
      // looking at this tab, so surface it globally too.
      pushToast({
        kind: "error",
        message: "Couldn't scan venture artifacts",
        detail: msg,
      });
      setScanError(msg);
    } finally {
      if (latestScanKey.current === key) setScanning(false);
    }
    // `selected` intentionally not in deps — including it would re-scan on
    // every selection change. Re-scan only on venture change or rescanToken.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ventureId, ventureRoot]);

  useEffect(() => {
    void runScan();
  }, [runScan, rescanToken]);

  // Group by artifact type for the left list.
  const grouped = useMemo(() => groupByType(artifacts), [artifacts]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 28px",
          borderBottom: "1px solid var(--bg-hover)",
          fontSize: 12,
          color: "var(--text-tertiary)",
        }}
      >
        <span>
          {scanning
            ? "Scanning…"
            : `${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"} found`}
        </span>
        <button
          type="button"
          onClick={() => void runScan()}
          disabled={scanning}
          style={{
            background: "none",
            border: "1px solid var(--border-input)",
            borderRadius: 6,
            color: "var(--text-secondary)",
            fontSize: 12,
            padding: "4px 10px",
            cursor: scanning ? "not-allowed" : "pointer",
          }}
        >
          {scanning ? "Scanning…" : "Re-scan"}
        </button>
      </div>

      {scanError && (
        <div
          style={{
            margin: "8px 28px 0",
            padding: "8px 12px",
            background: "var(--danger-soft)",
            color: "var(--danger)",
            border: "1px solid var(--danger-border)",
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          {scanError}
        </div>
      )}

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* List pane */}
        <div
          style={{
            width: 320,
            flexShrink: 0,
            borderRight: "1px solid var(--bg-hover)",
            overflowY: "auto",
            padding: "8px 0",
          }}
        >
          {artifacts.length === 0 && !scanning && (
            <div style={{ padding: "16px 20px", color: "var(--text-muted)", fontSize: 13 }}>
              Nothing on disk yet. Run the pipeline from the Overview tab to produce artifacts here.
            </div>
          )}
          {grouped.map(([type, items]) => (
            <div key={type} style={{ marginBottom: 8 }}>
              <div
                style={{
                  padding: "6px 20px",
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: 0.6,
                  color: "var(--text-tertiary)",
                  fontWeight: 700,
                }}
              >
                {type.replace(/-/g, " ")} ({items.length})
              </div>
              {items.map((a) => {
                const active = selected?.absolutePath === a.absolutePath;
                return (
                  <button
                    type="button"
                    key={a.absolutePath}
                    onClick={() => setSelected(a)}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "8px 20px",
                      background: active ? "var(--accent-soft)" : "transparent",
                      border: "none",
                      borderLeft: active ? "3px solid var(--accent)" : "3px solid transparent",
                      cursor: "pointer",
                      fontSize: 13,
                      color: active ? "var(--accent-hover)" : "var(--text-primary)",
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {a.filename}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--text-muted)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        marginTop: 2,
                      }}
                      title={a.relativePath}
                    >
                      {a.relativePath}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--text-muted)",
                        marginTop: 2,
                      }}
                    >
                      {formatBytes(a.sizeBytes)}
                      {a.modifiedAt ? ` · ${formatRelativeDate(a.modifiedAt)}` : ""}
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Preview pane */}
        <div style={{ flex: 1, minWidth: 0, overflow: "auto" }}>
          {selected ? (
            <PreviewPane key={selected.absolutePath} artifact={selected} />
          ) : (
            <div
              style={{
                padding: 28,
                color: "var(--text-muted)",
                fontSize: 13,
              }}
            >
              Select an artifact to preview it.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Preview pane
// ────────────────────────────────────────────────────────────────────

function PreviewPane({ artifact }: { artifact: ScannedArtifact }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [oversize, setOversize] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    setOversize(artifact.sizeBytes > PREVIEW_MAX_BYTES);

    if (artifact.sizeBytes > PREVIEW_MAX_BYTES) return;

    readArtifactText(artifact.absolutePath)
      .then((text) => {
        if (!cancelled) setContent(text);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[artifacts] preview read failed", err);
        const msg = errDetail(err);
        // Warn toast — the preview pane already shows the inline error
        // in red. Toast adds visibility when the user quickly switches
        // between files and might miss the inline text. Dedupe handles
        // the common "permission-denied across every preview click" case.
        pushToast({
          kind: "warn",
          message: `Couldn't preview "${artifact.filename}"`,
          detail: msg,
          ttlMs: 6000,
        });
        setError(msg);
      });

    return () => {
      cancelled = true;
    };
  }, [artifact]);

  return (
    <div style={{ padding: 28 }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)" }}>{artifact.filename}</div>
        <div
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            fontFamily: "ui-monospace, monospace",
            marginTop: 4,
            wordBreak: "break-all",
          }}
        >
          {artifact.relativePath}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
          {artifact.type} · {formatBytes(artifact.sizeBytes)}
        </div>
      </div>

      {oversize && (
        <div style={{ color: "var(--warning)", fontSize: 13 }}>
          File is larger than {Math.round(PREVIEW_MAX_BYTES / 1024)}KB — preview skipped. Open in
          Finder to view.
        </div>
      )}

      {error && <div style={{ color: "var(--danger)", fontSize: 13 }}>{error}</div>}

      {!oversize && content !== null && !error && (
        <PreviewBody artifact={artifact} content={content} />
      )}
    </div>
  );
}

function PreviewBody({
  artifact,
  content,
}: {
  artifact: ScannedArtifact;
  content: string;
}) {
  const ext = artifact.ext;

  if (ext === ".md" || ext === ".markdown") {
    return (
      <div
        style={{
          fontSize: 14,
          lineHeight: 1.6,
          color: "var(--text-primary)",
        }}
        dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
      />
    );
  }

  if (ext === ".json") {
    let pretty = content;
    try {
      pretty = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      // Leave as-is if it isn't valid JSON.
    }
    return <CodeBlock content={pretty} />;
  }

  if (ext === ".svg") {
    return (
      <div
        style={{
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-subtle)",
          borderRadius: 6,
          padding: 16,
          maxWidth: "100%",
          overflow: "auto",
        }}
        dangerouslySetInnerHTML={{ __html: content }}
      />
    );
  }

  if (ext === ".html" || ext === ".htm") {
    // Render the source — embedding arbitrary HTML from disk is risky and
    // we don't need a live preview in MVP.
    return <CodeBlock content={content} />;
  }

  if (ext === ".yaml" || ext === ".yml" || ext === ".txt" || ext === "") {
    return <CodeBlock content={content} />;
  }

  // Code-ish formats (ts, tsx, py, sh, etc.) — show as preformatted text.
  return <CodeBlock content={content} />;
}

function CodeBlock({ content }: { content: string }) {
  return (
    <pre
      style={{
        margin: 0,
        padding: 16,
        background: "var(--text-primary)",
        color: "var(--border-subtle)",
        borderRadius: 6,
        overflow: "auto",
        fontSize: 12,
        lineHeight: 1.5,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        whiteSpace: "pre",
      }}
    >
      {content}
    </pre>
  );
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function groupByType(items: ScannedArtifact[]): Array<[string, ScannedArtifact[]]> {
  const map = new Map<string, ScannedArtifact[]>();
  for (const a of items) {
    const list = map.get(a.type);
    if (list) list.push(a);
    else map.set(a.type, [a]);
  }
  return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatRelativeDate(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diffSec = Math.max(0, (Date.now() - t) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 7) return `${Math.round(diffSec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

async function persistArtifacts(ventureId: string, items: ScannedArtifact[]): Promise<void> {
  // Wipe + re-insert. Cheap for MVP volumes (10s-100s of files); switch to
  // diffing if this ever shows up in profiling.
  try {
    await db.clearArtifactsForVenture(ventureId);
    for (const a of items) {
      await db.upsertArtifact({
        artifactId: a.artifactId,
        ventureId,
        type: a.type,
        path: a.relativePath,
        status: "ready",
      });
    }
  } catch (err) {
    console.warn("[artifacts] DB persist failed", err);
  }
}
