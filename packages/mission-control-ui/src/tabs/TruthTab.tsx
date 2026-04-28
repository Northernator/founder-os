import { useState } from "react";
import type { TruthRunResponse } from "@founder-os/mission-control-protocol";
import type { TabProps } from "../App.js";
import { request } from "../lib/vscode.js";

/**
 * Truth tab — dispatches a GENERATE_TRUTH_LAYER handoff bundle through
 * the Phase 2 dispatcher and shows the produced TRUTH.md inline.
 */
export function TruthTab(_props: TabProps) {
  const [target, setTarget] = useState(".");
  const [scopeNotes, setScopeNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TruthRunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await request<TruthRunResponse>({
        type: "truth:run",
        target: target.trim() || ".",
        scopeNotes: scopeNotes.trim() || undefined,
      });
      setResult(r);
      if (r.status !== "success") {
        setError(r.error ?? "Run did not succeed");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="mc-card">
        <h3 className="mc-card-title">Truth Layer</h3>
        <p style={{ color: "var(--fc-fg-muted)", fontSize: 12, margin: "0 0 12px" }}>
          Generates a single canonical <code>TRUTH.md</code> at the venture root
          stating invariants, assumptions, and risks. Routed through the
          Phase 2 handoff dispatcher (GENERATE_TRUTH_LAYER bundle).
        </p>
        <div className="mc-grid" style={{ gridTemplateColumns: "auto 1fr" }}>
          <label htmlFor="truth-target">Target</label>
          <input
            id="truth-target"
            value={target}
            placeholder='e.g. "." for whole repo, or "src/auth" for a subsystem'
            onChange={(e) => setTarget(e.target.value)}
          />
          <label htmlFor="truth-scope" style={{ alignSelf: "start", marginTop: 6 }}>Scope notes</label>
          <textarea
            id="truth-scope"
            placeholder="Optional: anything specific the agent should focus on (constraints, recent incidents, hot spots)…"
            value={scopeNotes}
            onChange={(e) => setScopeNotes(e.target.value)}
            rows={3}
          />
        </div>
        <div className="mc-row" style={{ marginTop: 10, justifyContent: "flex-end" }}>
          <button onClick={run} disabled={busy}>
            {busy ? "Generating…" : "Generate TRUTH.md"}
          </button>
        </div>
      </div>

      {result && (
        <div className="mc-card">
          <div className="mc-row" style={{ justifyContent: "space-between" }}>
            <h3 className="mc-card-title" style={{ margin: 0 }}>
              Result{" "}
              <span className={"mc-pill " + statusClass(result.status)}>
                {result.status}
              </span>
            </h3>
            <span style={{ color: "var(--fc-fg-muted)", fontSize: 12 }}>
              run {result.runId}
            </span>
          </div>
          {result.summary && (
            <p style={{ marginTop: 8 }}>{result.summary}</p>
          )}
          {result.producedArtifacts && result.producedArtifacts.length > 0 && (
            <p style={{ marginTop: 8, color: "var(--fc-fg-muted)", fontSize: 12 }}>
              Produced:{" "}
              {result.producedArtifacts.map((a) => (
                <code key={a} style={{ marginRight: 6 }}>{a}</code>
              ))}
            </p>
          )}
          {result.body ? (
            <>
              <div style={{
                marginTop: 10, color: "var(--fc-fg-muted)", fontSize: 12,
              }}>
                <code>{result.bodyPath ?? "TRUTH.md"}</code>
              </div>
              <pre style={{
                marginTop: 4, maxHeight: 480, overflow: "auto",
                whiteSpace: "pre-wrap",
              }}>{result.body}</pre>
            </>
          ) : (
            <p style={{ marginTop: 8, color: "var(--fc-fg-muted)", fontSize: 12 }}>
              No <code>TRUTH.md</code> on disk after the run. Check the Output
              panel → "founder-cowork" channel for runner logs.
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="mc-card" style={{ borderColor: "var(--fc-error)" }}>
          <h3 className="mc-card-title" style={{ color: "var(--fc-error)" }}>Error</h3>
          <pre style={{ whiteSpace: "pre-wrap", color: "var(--fc-error)" }}>{error}</pre>
        </div>
      )}
    </>
  );
}

function statusClass(s: TruthRunResponse["status"]): string {
  switch (s) {
    case "success":   return "success";
    case "running":
    case "accepted":  return "warn";
    case "failed":
    case "cancelled": return "error";
  }
}
