import type { AgentId } from "@founder-os/agent-registry";
import { useState } from "react";
import type { TabProps } from "../App.js";
import { request } from "../lib/vscode.js";

/**
 * Explain tab — wraps the user's selection in an Explain prompt and
 * spawns an agent (default Claude). Output streams to a terminal pane;
 * the session also lands in the Sessions table on the Task tab.
 */
export function ExplainTab(props: TabProps) {
  const [selection, setSelection] = useState("");
  const [question, setQuestion] = useState("");
  const [agentId, setAgentId] = useState<AgentId | "">(
    (props.agents.find((a) => a.id === "claude")?.id as AgentId) ??
      (props.agents[0]?.id as AgentId) ??
      ""
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function run(): Promise<void> {
    if (!selection.trim()) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await request({
        type: "explain:run",
        selection,
        question: question.trim() || undefined,
        agentId: agentId || undefined,
      });
      setInfo("Spawned. Watch the terminal pane for streaming output.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="mc-card">
        <h3 className="mc-card-title">Explain</h3>
        <p style={{ color: "var(--fc-fg-muted)", fontSize: 12, margin: "0 0 12px" }}>
          Paste code or text below. The agent will explain it (defaults to a line-by-line
          walkthrough; override with a specific question above if you want something else).
        </p>
        <div className="mc-grid" style={{ gridTemplateColumns: "auto 1fr" }}>
          <label htmlFor="explain-agent">Agent</label>
          <select
            id="explain-agent"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value as AgentId)}
          >
            {props.agents.map((a) => {
              const h = props.agentHealth[a.id];
              const tag = h === undefined ? "?" : h.healthy ? "✓" : "⚠";
              return (
                <option key={a.id} value={a.id}>
                  {a.icon} {a.label} ({tag})
                </option>
              );
            })}
          </select>
          <label htmlFor="explain-q">Question</label>
          <input
            id="explain-q"
            placeholder="Optional — defaults to 'explain line by line + summary'"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <label htmlFor="explain-sel" style={{ alignSelf: "start", marginTop: 6 }}>
            Selection
          </label>
          <textarea
            id="explain-sel"
            placeholder="Paste code, config, error message, or any text here…"
            value={selection}
            onChange={(e) => setSelection(e.target.value)}
            rows={12}
          />
        </div>
        <div className="mc-row" style={{ marginTop: 10, justifyContent: "flex-end" }}>
          <button onClick={run} disabled={busy || !selection.trim()}>
            {busy ? "Spawning…" : "Explain"}
          </button>
        </div>
      </div>

      {info && (
        <div className="mc-card">
          <p style={{ margin: 0 }}>{info}</p>
        </div>
      )}

      {error && (
        <div className="mc-card" style={{ borderColor: "var(--fc-error)" }}>
          <h3 className="mc-card-title" style={{ color: "var(--fc-error)" }}>
            Error
          </h3>
          <pre style={{ whiteSpace: "pre-wrap", color: "var(--fc-error)" }}>{error}</pre>
        </div>
      )}
    </>
  );
}
