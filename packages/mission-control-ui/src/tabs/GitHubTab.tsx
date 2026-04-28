import { useEffect, useState } from "react";
import type {
  GitStatusResponse,
  GitCommitResponse,
  GitCreatePrResponse,
} from "@founder-os/mission-control-protocol";
import type { TabProps } from "../App.js";
import { request } from "../lib/vscode.js";

export function GitHubTab(_props: TabProps) {
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [branchName, setBranchName] = useState("");
  const [commitMsg, setCommitMsg] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [lastPrUrl, setLastPrUrl] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    setBusy("status");
    setError(null);
    try {
      const s = await request<GitStatusResponse>({ type: "github:status" });
      setStatus(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => { void refresh(); /* on mount */ }, []);

  async function doCreateBranch(): Promise<void> {
    if (!branchName.trim()) return;
    setBusy("branch");
    setError(null);
    try {
      await request({ type: "github:createBranch", name: branchName.trim() });
      setBranchName("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function doCommitAndPush(): Promise<void> {
    if (!commitMsg.trim()) return;
    setBusy("commit");
    setError(null);
    try {
      const r = await request<GitCommitResponse>({
        type: "github:commitAndPush",
        message: commitMsg.trim(),
      });
      setCommitMsg("");
      await refresh();
      if (!r.pushed) {
        setError("Committed " + r.commitSha.slice(0, 8) +
          " but push failed: " + (r.pushHint ?? "unknown"));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function doCreatePR(): Promise<void> {
    if (!prTitle.trim()) return;
    setBusy("pr");
    setError(null);
    try {
      const r = await request<GitCreatePrResponse>({
        type: "github:createPR",
        title: prTitle.trim(),
        body: prBody.trim(),
      });
      setLastPrUrl(r.url);
      setPrTitle("");
      setPrBody("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="mc-card">
        <div className="mc-row" style={{ justifyContent: "space-between" }}>
          <h3 className="mc-card-title" style={{ margin: 0 }}>Status</h3>
          <button className="secondary" onClick={refresh} disabled={busy !== null}>
            {busy === "status" ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        {!status && !error && <div className="mc-empty">Loading…</div>}
        {status && (
          <>
            <div className="mc-row" style={{ gap: 12, flexWrap: "wrap", marginTop: 8 }}>
              <span className="mc-pill success">{status.branch ?? "(detached)"}</span>
              {status.tracking && <span className="mc-pill">tracks {status.tracking}</span>}
              {status.ahead > 0 && <span className="mc-pill warn">{status.ahead} ahead</span>}
              {status.behind > 0 && <span className="mc-pill warn">{status.behind} behind</span>}
              <span className={"mc-pill " + (status.isClean ? "success" : "warn")}>
                {status.isClean ? "clean" : status.changedFiles.length + " changed"}
              </span>
            </div>
            {status.changedFiles.length > 0 && (
              <table className="mc-table" style={{ marginTop: 10 }}>
                <thead><tr><th style={{ width: 40 }}>St</th><th>Path</th></tr></thead>
                <tbody>
                  {status.changedFiles.map((f) => (
                    <tr key={f.path + f.status}>
                      <td><code>{f.status}</code></td>
                      <td><code>{f.path}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>

      <div className="mc-card">
        <h3 className="mc-card-title">Create branch</h3>
        <div className="mc-row" style={{ gap: 8 }}>
          <input
            placeholder="my-feature-branch"
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
          />
          <button onClick={doCreateBranch} disabled={!branchName.trim() || busy !== null}>
            {busy === "branch" ? "Creating…" : "Create"}
          </button>
        </div>
        <p style={{ color: "var(--fc-fg-muted)", fontSize: 12, margin: "8px 0 0" }}>
          Names get sanitized (only A-Z a-z 0-9 _ . / -). Branches off the current HEAD.
        </p>
      </div>

      <div className="mc-card">
        <h3 className="mc-card-title">Commit + push</h3>
        <textarea
          placeholder="Commit message"
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          rows={3}
        />
        <div className="mc-row" style={{ marginTop: 8, justifyContent: "flex-end" }}>
          <button onClick={doCommitAndPush} disabled={!commitMsg.trim() || busy !== null}>
            {busy === "commit" ? "Committing…" : "Commit + push"}
          </button>
        </div>
        <p style={{ color: "var(--fc-fg-muted)", fontSize: 12, margin: "8px 0 0" }}>
          Stages all changes (`git add -A`), commits, and pushes with `--set-upstream`
          if needed. Push errors don't block the commit — you'll get a warning.
        </p>
      </div>

      <div className="mc-card">
        <h3 className="mc-card-title">Create pull request (gh CLI)</h3>
        <input
          placeholder="PR title"
          value={prTitle}
          onChange={(e) => setPrTitle(e.target.value)}
        />
        <textarea
          placeholder="PR body (markdown)"
          value={prBody}
          onChange={(e) => setPrBody(e.target.value)}
          rows={4}
          style={{ marginTop: 8 }}
        />
        <div className="mc-row" style={{ marginTop: 8, justifyContent: "flex-end" }}>
          <button onClick={doCreatePR} disabled={!prTitle.trim() || busy !== null}>
            {busy === "pr" ? "Creating…" : "Create PR"}
          </button>
        </div>
        {lastPrUrl && (
          <p style={{ marginTop: 10 }}>
            <strong>PR created:</strong> <a href={lastPrUrl} target="_blank" rel="noreferrer">{lastPrUrl}</a>
          </p>
        )}
        <p style={{ color: "var(--fc-fg-muted)", fontSize: 12, margin: "8px 0 0" }}>
          Requires the GitHub CLI (`gh`) on PATH and `gh auth login`. Token-based PR
          creation lands with packages/agent-accounts in Phase 3.
        </p>
      </div>

      {error && (
        <div className="mc-card" style={{ borderColor: "var(--fc-error)" }}>
          <h3 className="mc-card-title" style={{ color: "var(--fc-error)" }}>Error</h3>
          <pre style={{ whiteSpace: "pre-wrap", color: "var(--fc-error)" }}>{error}</pre>
        </div>
      )}
    </>
  );
}
