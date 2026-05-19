/**
 * VaultImportProgressScreen -- phases 1-9 progress + warnings panel.
 *
 * Slice 9 ships the renderer-side surface. The spec's "poll the job
 * row (1s) + tail the log file" maps onto the in-memory progress
 * stream the run-vault-import helper emits via onProgress -- slice 12
 * will swap this for a Tauri-backed poll once the SQLite job table +
 * logs.jsonl get IPC commands.
 *
 * Phases pinned by VAULT_LOG_STRINGS (drift-protected in @founder-os/vault-runner):
 *   1. Copying files to import cache
 *   2. Detecting file types
 *   3. Extracting text
 *   4. Analysing images
 *   5. Parsing chats
 *   6. Classifying projects
 *   7. Extracting knowledge
 *   8. Generating draft vault notes
 *   9. Ready for review
 */
import type { Venture } from "@founder-os/domain";
import type { ProjectCandidate } from "@founder-os/project-classifier";
import { VAULT_LOG_STRINGS } from "@founder-os/vault-runner";
import { useEffect, useRef, useState } from "react";
import {
  type ProgressEvent,
  type RunVaultImportResult,
  type VaultImportSourceInput,
  runVaultImport,
} from "../run-vault-import.js";

export type VaultImportProgressScreenProps = {
  jobId: string;
  sources: VaultImportSourceInput[];
  workspaceRoot: string;
  ventures: Venture[];
  activeVentureId: string | null;
  /** Defaults to "local" when omitted -- the runner uses this on the ImportJob row. */
  provider?: Parameters<typeof runVaultImport>[0]["provider"];
  mode?: Parameters<typeof runVaultImport>[0]["mode"];
  onDone: () => void;
  /**
   * Bubbled up to App.tsx when the runner reaches needs_review. App.tsx
   * stashes the full RunVaultImportResult in `pendingVaultImports` so the
   * review screen (and the VaultPendingImportsPanel) can pick it up
   * even after this modal is dismissed. Slice 10 -- in-memory only;
   * slice 12 wires Rust persistence.
   */
  onReadyForReview?: (jobId: string, result: RunVaultImportResult) => void;
  /**
   * Called when the user clicks the "Review imports →" CTA on the
   * progress screen. Lets the flow swap to the review screen without
   * closing the modal.
   */
  onReviewNow?: () => void;
};

type PhaseState = "pending" | "running" | "done" | "warn";

const PHASE_ORDER: { key: keyof typeof VAULT_LOG_STRINGS; label: string }[] = [
  { key: "copying", label: "Copying files to import cache" },
  { key: "detecting", label: "Detecting file types" },
  { key: "extractingText", label: "Extracting text" },
  { key: "analysingImages", label: "Analysing images" },
  { key: "parsingChats", label: "Parsing chats" },
  { key: "classifying", label: "Classifying projects" },
  { key: "extractingKnowledge", label: "Extracting knowledge" },
  { key: "generatingDrafts", label: "Generating draft vault notes" },
  { key: "readyForReview", label: "Ready for review" },
];

function buildCandidatesFromVentures(ventures: Venture[]): ProjectCandidate[] {
  return ventures.map((v) => ({ projectId: v.id, name: v.name, slug: v.slug }));
}

export function VaultImportProgressScreen({
  jobId,
  sources,
  workspaceRoot,
  ventures,
  activeVentureId,
  provider = "local",
  mode = "files",
  onDone,
  onReadyForReview,
  onReviewNow,
}: VaultImportProgressScreenProps) {
  const [phases, setPhases] = useState<Record<string, PhaseState>>(() => {
    const initial: Record<string, PhaseState> = {};
    for (const phase of PHASE_ORDER) initial[phase.label] = "pending";
    return initial;
  });
  const [logLines, setLogLines] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [stagedNames, setStagedNames] = useState<string[]>([]);
  const [failedSources, setFailedSources] = useState<Array<{ name: string; error: string }>>([]);
  const [result, setResult] = useState<RunVaultImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const handleProgress = (event: ProgressEvent) => {
      if (event.kind === "phase") {
        setLogLines((prev) => prev.concat(event.message));
        setPhases((prev) => {
          const next = { ...prev };
          if (event.message in next) {
            next[event.message] = "done";
          }
          return next;
        });
      } else if (event.kind === "source_staged") {
        setStagedNames((prev) => prev.concat(event.originalName));
      } else if (event.kind === "source_failed") {
        setFailedSources((prev) => prev.concat({ name: event.originalName, error: event.error }));
      } else if (event.kind === "ready_for_review") {
        setPhases((prev) => ({ ...prev, [VAULT_LOG_STRINGS.readyForReview]: "done" }));
      }
    };

    (async () => {
      try {
        const candidates = buildCandidatesFromVentures(ventures);
        const opts: Parameters<typeof runVaultImport>[0] = {
          workspaceRoot,
          provider,
          mode,
          sources,
          candidates,
          onProgress: handleProgress,
        };
        if (activeVentureId) opts.ventureId = activeVentureId;
        const runResult = await runVaultImport(opts);
        setResult(runResult);
        setWarnings(runResult.run.warnings);
        if (runResult.run.status === "failed") {
          setError(runResult.run.error?.message ?? "Vault import failed");
        } else if (runResult.run.status === "needs_review") {
          onReadyForReview?.(jobId, runResult);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    // biome-ignore lint/correctness/useExhaustiveDependencies: callbacks intentionally not included
  }, [activeVentureId, sources, ventures, workspaceRoot, provider, mode]);

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 14,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
          Importing {sources.length} {sources.length === 1 ? "source" : "sources"}
        </h3>
        {result?.run.status === "needs_review" && (
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={onDone}
              style={{
                ...primaryBtn,
                background: "transparent",
                color: "var(--text-secondary, #4B5563)",
                border: "1px solid var(--border-subtle, #E5E7EB)",
              }}
            >
              Review later
            </button>
            {onReviewNow && (
              <button type="button" onClick={onReviewNow} style={primaryBtn}>
                Review imports →
              </button>
            )}
          </div>
        )}
      </div>

      <PhaseList phases={phases} />

      {stagedNames.length > 0 && (
        <section style={{ marginTop: 18 }}>
          <h4 style={subHead}>Staged ({stagedNames.length})</h4>
          <ul style={{ ...listStyle, maxHeight: 110 }}>
            {stagedNames.map((name) => (
              <li key={name} style={listItem}>
                {name}
              </li>
            ))}
          </ul>
        </section>
      )}

      {failedSources.length > 0 && (
        <section style={{ marginTop: 18 }}>
          <h4 style={{ ...subHead, color: "#B91C1C" }}>
            Failed ({failedSources.length})
          </h4>
          <ul style={{ ...listStyle, maxHeight: 110 }}>
            {failedSources.map((f) => (
              <li key={f.name} style={{ ...listItem, borderColor: "#FCA5A5" }}>
                <strong>{f.name}</strong> — {f.error}
              </li>
            ))}
          </ul>
        </section>
      )}

      {warnings.length > 0 && (
        <section style={{ marginTop: 18 }}>
          <h4 style={subHead}>Warnings ({warnings.length})</h4>
          <ul style={{ ...listStyle, maxHeight: 130 }}>
            {warnings.slice(0, 50).map((w, idx) => (
              <li
                key={`${idx}-${w.slice(0, 16)}`}
                style={{ ...listItem, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 11 }}
              >
                {w}
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && (
        <p style={{ margin: "16px 0 0", color: "#B91C1C", fontSize: 13 }}>
          <strong>Import failed:</strong> {error}
        </p>
      )}

      {result && result.run.status === "needs_review" && (
        <section style={{ marginTop: 18 }}>
          <h4 style={subHead}>Ready for review</h4>
          <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--text-secondary, #4B5563)" }}>
            {result.run.drafts.length} draft {result.run.drafts.length === 1 ? "note" : "notes"} produced
            across {result.run.perSource.length} source{result.run.perSource.length === 1 ? "" : "s"}.
            Click <strong>Review imports →</strong> above, or step away — the run stays pinned in
            <em> Pending vault imports </em> on the home screen.
          </p>
        </section>
      )}

      <section style={{ marginTop: 18 }}>
        <h4 style={subHead}>Log</h4>
        <pre
          style={{
            margin: 0,
            padding: "10px 12px",
            background: "#0F172A",
            color: "#E5E7EB",
            borderRadius: 10,
            fontSize: 11,
            lineHeight: 1.5,
            maxHeight: 180,
            overflowY: "auto",
            fontFamily: "ui-monospace, Menlo, monospace",
          }}
        >
          {logLines.join("\n")}
        </pre>
      </section>
    </div>
  );
}

function PhaseList({ phases }: { phases: Record<string, PhaseState> }) {
  return (
    <ol style={{ margin: 0, padding: 0, listStyle: "none" }}>
      {PHASE_ORDER.map(({ key: _k, label }) => {
        const state = phases[label] ?? "pending";
        return (
          <li
            key={label}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "6px 8px",
              borderRadius: 8,
              background:
                state === "done"
                  ? "color-mix(in srgb, #10B981 12%, transparent)"
                  : "transparent",
              fontSize: 13,
            }}
          >
            <span aria-hidden="true" style={{ width: 18 }}>
              {state === "done" ? "✓" : state === "running" ? "…" : state === "warn" ? "!" : "○"}
            </span>
            <span
              style={{
                color: state === "done" ? "#065F46" : "var(--text-primary, #0F172A)",
                fontWeight: state === "done" ? 700 : 500,
              }}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

const subHead: React.CSSProperties = {
  margin: "0 0 6px",
  fontSize: 13,
  fontWeight: 700,
  color: "var(--text-secondary, #4B5563)",
};

const listStyle: React.CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: "none",
  overflowY: "auto",
};

const listItem: React.CSSProperties = {
  padding: "6px 10px",
  fontSize: 12,
  background: "var(--bg-muted, #F9FAFB)",
  border: "1px solid var(--border-subtle, #E5E7EB)",
  borderRadius: 8,
  marginBottom: 4,
};

const primaryBtn: React.CSSProperties = {
  padding: "8px 14px",
  background: "var(--accent, #4F46E5)",
  color: "var(--accent-fg, #FFFFFF)",
  border: "1px solid transparent",
  borderRadius: 8,
  fontWeight: 700,
  fontSize: 13,
  cursor: "pointer",
};
