import type { TabProps } from "../App.js";
import { send } from "../lib/vscode.js";

/**
 * Agent registry view + health. Account-switching UI lands in Phase 3
 * once packages/agent-accounts is in place.
 */
export function AgentsTab(props: TabProps) {
  return (
    <>
      <div className="mc-card">
        <div className="mc-row" style={{ justifyContent: "space-between" }}>
          <h3 className="mc-card-title" style={{ margin: 0 }}>
            Registered agents
          </h3>
          <button className="secondary" onClick={() => send({ type: "agents:rerunPreflight" })}>
            Re-run preflight
          </button>
        </div>
        <table className="mc-table" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th></th>
              <th>Agent</th>
              <th>ID</th>
              <th>Auth</th>
              <th>Prompt</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {props.agents.map((a) => {
              const h = props.agentHealth[a.id];
              const status =
                h === undefined ? (
                  <span className="mc-pill">pending</span>
                ) : h.healthy ? (
                  <span className="mc-pill success">ready</span>
                ) : (
                  <span className="mc-pill error">{h.hint ?? "missing"}</span>
                );
              return (
                <tr key={a.id}>
                  <td>{a.icon}</td>
                  <td>
                    <strong>{a.label}</strong>
                  </td>
                  <td>
                    <code>{a.id}</code>
                  </td>
                  <td>{a.authStyle}</td>
                  <td>{a.promptInjection}</td>
                  <td>{status}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p style={{ marginTop: 8, color: "var(--fc-fg-muted)", fontSize: 12 }}>
          A red status means the binary isn't on PATH. Install the CLI and log in, then re-run
          preflight. Spawning an unhealthy agent is allowed but you'll get a confirmation prompt.
        </p>
      </div>

      <div className="mc-card">
        <h3 className="mc-card-title">Accounts (Phase 3)</h3>
        <p style={{ color: "var(--fc-fg-muted)", margin: 0 }}>
          Per-agent account switching (Codex managed-account pattern, Claude system-default
          snapshot, Gemini SecretStorage) lands in Phase 3 with packages/agent-accounts. For now,
          agents use whichever credentials their CLI is logged in with.
        </p>
        <div className="mc-row" style={{ marginTop: 10 }}>
          <button
            className="secondary"
            onClick={() => send({ type: "settings:open", query: "founderCowork.providers" })}
          >
            Open extension settings
          </button>
        </div>
      </div>
    </>
  );
}
