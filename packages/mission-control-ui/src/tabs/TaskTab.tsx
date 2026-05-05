import type { AgentId } from "@founder-os/agent-registry";
import type { ApproveResponse, SessionsStatsResponse } from "@founder-os/mission-control-protocol";
import { type ReactNode, useEffect, useState } from "react";
import type { TabProps } from "../App.js";
import { request, send } from "../lib/vscode.js";

/**
 * Task tab - the home of session spawning + the v0.4.0 PM workflow.
 * Top half: spawn / orchestrate / sessions table.
 * Bottom: collapsible "PM workflow" card driving the 9 task: commands.
 */
export function TaskTab(props: TabProps) {
  const [agentId, setAgentId] = useState<AgentId | "">((props.agents[0]?.id as AgentId) ?? "");
  const [prompt, setPrompt] = useState("");
  const [orchestrating, setOrchestrating] = useState(false);
  const [pmAgent, setPmAgent] = useState<AgentId | "">("");
  const [executorAgent, setExecutorAgent] = useState<AgentId | "">("");
  const [goal, setGoal] = useState("");

  function handleSpawn(): void {
    if (!agentId || !prompt.trim()) return;
    send({ type: "session:spawn", agentId, prompt });
    setPrompt("");
  }

  function handleOrchestrate(): void {
    if (!pmAgent || !executorAgent || !goal.trim()) return;
    send({
      type: "session:orchestrate",
      pmAgentId: pmAgent,
      executorAgentId: executorAgent,
      goal,
    });
    setGoal("");
  }

  return (
    <>
      <div className="mc-card">
        <h3 className="mc-card-title">Spawn agent session</h3>
        <div className="mc-grid" style={{ gridTemplateColumns: "auto 1fr" }}>
          <label htmlFor="agent">Agent</label>
          <select
            id="agent"
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
          <label htmlFor="prompt" style={{ alignSelf: "start", marginTop: 6 }}>
            Prompt
          </label>
          <textarea
            id="prompt"
            placeholder="What should the agent work on?"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={6}
          />
        </div>
        <div className="mc-row" style={{ marginTop: 10, justifyContent: "flex-end" }}>
          <button type="button" onClick={handleSpawn} disabled={!agentId || !prompt.trim()}>
            Spawn session
          </button>
        </div>
      </div>

      <div className="mc-card">
        <h3 className="mc-card-title">
          Orchestrate (PM + Executor){" "}
          <button
            type="button"
            className="secondary"
            style={{ float: "right", padding: "2px 8px", fontSize: 12 }}
            onClick={() => setOrchestrating((v) => !v)}
          >
            {orchestrating ? "Hide" : "Show"}
          </button>
        </h3>
        {orchestrating && (
          <div className="mc-grid" style={{ gridTemplateColumns: "auto 1fr" }}>
            <label htmlFor="pm">PM agent</label>
            <select id="pm" value={pmAgent} onChange={(e) => setPmAgent(e.target.value as AgentId)}>
              <option value="">— pick one —</option>
              {props.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.icon} {a.label}
                </option>
              ))}
            </select>
            <label htmlFor="exec">Executor</label>
            <select
              id="exec"
              value={executorAgent}
              onChange={(e) => setExecutorAgent(e.target.value as AgentId)}
            >
              <option value="">— pick one —</option>
              {props.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.icon} {a.label}
                </option>
              ))}
            </select>
            <label htmlFor="goal" style={{ alignSelf: "start", marginTop: 6 }}>
              Goal
            </label>
            <textarea
              id="goal"
              placeholder="High-level goal — PM writes TASK.md, Executor implements"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={3}
            />
            <div />
            <div className="mc-row" style={{ marginTop: 6, justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={handleOrchestrate}
                disabled={!pmAgent || !executorAgent || !goal.trim()}
              >
                Orchestrate
              </button>
            </div>
          </div>
        )}
      </div>

      <SessionsCard sessions={props.sessions} />

      <PmWorkflowCard agents={props.agents} agentHealth={props.agentHealth} />
    </>
  );
}

// ──────────────────────────────────────────────
// Sessions table
// ──────────────────────────────────────────────

function SessionsCard(props: { sessions: TabProps["sessions"] }) {
  const runningCount = props.sessions.filter((s) => s.status === "running").length;
  return (
    <div className="mc-card">
      <h3 className="mc-card-title">Sessions</h3>
      {props.sessions.length === 0 ? (
        <div className="mc-empty">No sessions yet. Spawn one above or press Ctrl+Shift+A.</div>
      ) : (
        <table className="mc-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Branch</th>
              <th>Status</th>
              <th>PID</th>
              <th>Started</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {props.sessions.map((s) => (
              <tr key={s.id}>
                <td>{s.agentLabel}</td>
                <td>
                  <code>{s.branch}</code>
                </td>
                <td>
                  <span className={`mc-pill ${statusClass(s.status)}`}>{s.status}</span>
                </td>
                <td>{s.pid}</td>
                <td>{new Date(s.startedAt).toLocaleTimeString()}</td>
                <td className="mc-row" style={{ gap: 6, justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => send({ type: "session:show", sessionId: s.id })}
                  >
                    Show
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => send({ type: "session:kill", sessionId: s.id })}
                    disabled={s.status !== "running"}
                  >
                    Kill
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {runningCount > 0 && (
        <p style={{ marginTop: 8, color: "var(--fc-fg-muted)", fontSize: 12 }}>
          {runningCount} running
        </p>
      )}
    </div>
  );
}

function statusClass(s: "running" | "exited" | "killed"): string {
  switch (s) {
    case "running":
      return "success";
    case "exited":
      return "";
    case "killed":
      return "warn";
  }
}

// ──────────────────────────────────────────────
// PM workflow card (Phase 1b.5)
// ──────────────────────────────────────────────

interface PmWorkflowCardProps {
  agents: TabProps["agents"];
  agentHealth: TabProps["agentHealth"];
}

function PmWorkflowCard(props: PmWorkflowCardProps) {
  const [open, setOpen] = useState(true);
  const [planGoal, setPlanGoal] = useState("");
  const [executor, setExecutor] = useState<AgentId | "">(
    (props.agents.find((a) => a.id !== "claude")?.id as AgentId) ??
      (props.agents[0]?.id as AgentId) ??
      ""
  );
  const [revisionNotes, setRevisionNotes] = useState("");
  const [askGeminiQ, setAskGeminiQ] = useState("");
  const [askGeminiDiffQ, setAskGeminiDiffQ] = useState("");
  const [stats, setStats] = useState<SessionsStatsResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastApprove, setLastApprove] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refreshStats(): Promise<void> {
    setBusy("stats");
    setError(null);
    try {
      const r = await request<SessionsStatsResponse>({ type: "stats:refresh" });
      setStats(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps intentionally omitted
  useEffect(() => {
    void refreshStats();
  }, []);

  async function fire(label: string, msg: Parameters<typeof request>[0]): Promise<void> {
    setBusy(label);
    setError(null);
    try {
      await request(msg);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function approve(): Promise<void> {
    setBusy("approve");
    setError(null);
    try {
      const r = await request<ApproveResponse>({ type: "task:approve" });
      setLastApprove(r.commitSha);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mc-card">
      <h3 className="mc-card-title">
        PM workflow{" "}
        <button
          type="button"
          className="secondary"
          style={{ float: "right", padding: "2px 8px", fontSize: 12 }}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide" : "Show"}
        </button>
      </h3>
      {!open && (
        <p style={{ color: "var(--fc-fg-muted)", fontSize: 12, margin: 0 }}>
          Analyze · Plan · Execute · Review · Approve / Revise · Ask Gemini
        </p>
      )}
      {open && (
        <>
          <p style={{ color: "var(--fc-fg-muted)", fontSize: 12, margin: "0 0 12px" }}>
            Each step spawns an agent that lands in the Sessions table above. Files written:{" "}
            <code>ANALYSIS.md</code>, <code>TASK.md</code>, <code>REVIEW.md</code>.
          </p>

          <div className="mc-grid" style={{ gap: 14 }}>
            <SubCard title="1. Analyze repo">
              <p style={{ color: "var(--fc-fg-muted)", fontSize: 12, margin: 0 }}>
                Claude reads the repo and writes <code>ANALYSIS.md</code>.
              </p>
              <div className="mc-row" style={{ marginTop: 8, justifyContent: "flex-end" }}>
                <button
                  type="button"
                  onClick={() => void fire("analyze", { type: "task:analyzeRepo" })}
                  disabled={busy !== null}
                >
                  {busy === "analyze" ? "Spawning…" : "Analyze"}
                </button>
              </div>
            </SubCard>

            <SubCard title="2. Plan task">
              <textarea
                placeholder="High-level goal — PM writes TASK.md describing how to do it"
                value={planGoal}
                onChange={(e) => setPlanGoal(e.target.value)}
                rows={2}
              />
              <div className="mc-row" style={{ marginTop: 8, justifyContent: "flex-end" }}>
                <button
                  type="button"
                  onClick={() => {
                    if (!planGoal.trim()) return;
                    void fire("plan", { type: "task:planTask", goal: planGoal.trim() });
                  }}
                  disabled={busy !== null || !planGoal.trim()}
                >
                  {busy === "plan" ? "Spawning…" : "Plan"}
                </button>
              </div>
            </SubCard>

            <SubCard title="3. Execute (reads TASK.md)">
              <div className="mc-grid" style={{ gridTemplateColumns: "auto 1fr" }}>
                <label htmlFor="exec-agent">Executor</label>
                <select
                  id="exec-agent"
                  value={executor}
                  onChange={(e) => setExecutor(e.target.value as AgentId)}
                >
                  {props.agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.icon} {a.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="mc-row" style={{ marginTop: 8, justifyContent: "flex-end" }}>
                <button
                  type="button"
                  onClick={() => {
                    if (!executor) return;
                    void fire("execute", {
                      type: "task:executeTask",
                      executorAgentId: executor as AgentId,
                    });
                  }}
                  disabled={busy !== null || !executor}
                >
                  {busy === "execute" ? "Spawning…" : "Execute"}
                </button>
              </div>
            </SubCard>

            <SubCard title="4. Review (reads diff -> REVIEW.md)">
              <p style={{ color: "var(--fc-fg-muted)", fontSize: 12, margin: 0 }}>
                Claude reads <code>git diff</code> and writes <code>REVIEW.md</code> with verdict.
              </p>
              <div className="mc-row" style={{ marginTop: 8, justifyContent: "flex-end" }}>
                <button
                  type="button"
                  onClick={() => void fire("review", { type: "task:reviewExecution" })}
                  disabled={busy !== null}
                >
                  {busy === "review" ? "Spawning…" : "Review"}
                </button>
              </div>
            </SubCard>

            <SubCard title="5. Approve or request revision">
              <div className="mc-row" style={{ gap: 8, alignItems: "flex-end", marginBottom: 12 }}>
                <button type="button" onClick={approve} disabled={busy !== null}>
                  {busy === "approve" ? "Committing…" : "Approve (commit)"}
                </button>
                {lastApprove && <span className="mc-pill success">{lastApprove.slice(0, 8)}</span>}
              </div>
              <textarea
                placeholder="Revision notes for the executor"
                value={revisionNotes}
                onChange={(e) => setRevisionNotes(e.target.value)}
                rows={3}
              />
              <div className="mc-row" style={{ marginTop: 8, justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    if (!executor || !revisionNotes.trim()) return;
                    void fire("revise", {
                      type: "task:requestRevision",
                      executorAgentId: executor as AgentId,
                      notes: revisionNotes.trim(),
                    });
                    setRevisionNotes("");
                  }}
                  disabled={busy !== null || !executor || !revisionNotes.trim()}
                >
                  {busy === "revise" ? "Spawning…" : "Request revision"}
                </button>
              </div>
            </SubCard>

            <SubCard title="Ask Gemini">
              <textarea
                placeholder="Question for Gemini"
                value={askGeminiQ}
                onChange={(e) => setAskGeminiQ(e.target.value)}
                rows={2}
              />
              <div className="mc-row" style={{ marginTop: 8, justifyContent: "flex-end" }}>
                <button
                  type="button"
                  onClick={() => {
                    if (!askGeminiQ.trim()) return;
                    void fire("ask", { type: "task:askGemini", question: askGeminiQ.trim() });
                    setAskGeminiQ("");
                  }}
                  disabled={busy !== null || !askGeminiQ.trim()}
                >
                  {busy === "ask" ? "Spawning…" : "Ask Gemini"}
                </button>
              </div>
            </SubCard>

            <SubCard title="Ask Gemini about the current diff">
              <textarea
                placeholder="Question — diff is auto-attached"
                value={askGeminiDiffQ}
                onChange={(e) => setAskGeminiDiffQ(e.target.value)}
                rows={2}
              />
              <div className="mc-row" style={{ marginTop: 8, justifyContent: "flex-end" }}>
                <button
                  type="button"
                  onClick={() => {
                    if (!askGeminiDiffQ.trim()) return;
                    void fire("ask-diff", {
                      type: "task:askGeminiDiff",
                      question: askGeminiDiffQ.trim(),
                    });
                    setAskGeminiDiffQ("");
                  }}
                  disabled={busy !== null || !askGeminiDiffQ.trim()}
                >
                  {busy === "ask-diff" ? "Spawning…" : "Ask"}
                </button>
              </div>
            </SubCard>
          </div>

          <div className="mc-row" style={{ gap: 8, marginTop: 14, alignItems: "center" }}>
            <button
              type="button"
              className="secondary"
              onClick={refreshStats}
              disabled={busy !== null}
            >
              {busy === "stats" ? "Loading…" : "Refresh stats"}
            </button>
            {stats && (
              <span style={{ color: "var(--fc-fg-muted)", fontSize: 12 }}>
                {stats.total} total ·{" "}
                <span style={{ color: "var(--fc-success)" }}>{stats.running} running</span> ·{" "}
                {stats.exited} exited ·{" "}
                <span style={{ color: "var(--fc-warning)" }}>{stats.killed} killed</span>
              </span>
            )}
          </div>

          {error && (
            <pre
              style={{
                marginTop: 10,
                color: "var(--fc-error)",
                whiteSpace: "pre-wrap",
                border: "1px solid var(--fc-error)",
                padding: 10,
                borderRadius: "var(--fc-radius)",
              }}
            >
              {error}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

function SubCard(props: { title: string; children: ReactNode }) {
  return (
    <div
      style={{
        border: "1px solid var(--fc-border)",
        borderRadius: "var(--fc-radius)",
        padding: "10px 12px",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{props.title}</div>
      {props.children}
    </div>
  );
}
