import { useEffect, useState } from "react";
import type {
  SkillSummary,
  SkillBodyResponse,
  SkillSource,
  SkillsListResponse,
} from "@founder-os/mission-control-protocol";
import type { TabProps } from "../App.js";
import { request, send } from "../lib/vscode.js";

/**
 * Skills tab — read-only browser over three skill sources (workspace, user,
 * bundled). Click a row to expand the SKILL.md body. "Copy prompt" puts the
 * body on the clipboard so it can be pasted into the Task tab as context.
 */
export function SkillsTab(_props: TabProps) {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [bodyCache, setBodyCache] = useState<Record<string, SkillBodyResponse>>({});

  async function refresh(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await request<SkillsListResponse>({ type: "skills:list" });
      setSkills(r.skills);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function toggle(s: SkillSummary): Promise<void> {
    const key = s.source + "::" + s.id;
    if (expandedKey === key) {
      setExpandedKey(null);
      return;
    }
    setExpandedKey(key);
    if (bodyCache[key]) return;
    try {
      const body = await request<SkillBodyResponse>({
        type: "skills:read",
        id: s.id,
        source: s.source,
      });
      setBodyCache((c) => ({ ...c, [key]: body }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setExpandedKey(null);
    }
  }

  async function copyToClipboard(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Webview may block clipboard.writeText on focus loss; fall back to host toast.
      send({ type: "toast", level: "warn", message: "Copy failed - manual select required." } as never);
    }
  }

  const grouped = groupBySource(skills ?? []);

  return (
    <>
      <div className="mc-card">
        <div className="mc-row" style={{ justifyContent: "space-between" }}>
          <h3 className="mc-card-title" style={{ margin: 0 }}>Skills</h3>
          <button className="secondary" onClick={refresh} disabled={busy}>
            {busy ? "Scanning…" : "Refresh"}
          </button>
        </div>
        <p style={{ color: "var(--fc-fg-muted)", fontSize: 12, margin: "8px 0 0" }}>
          Loaded from three locations (workspace overrides user overrides bundled).
          Drop a folder containing a <code>SKILL.md</code> into any of these:
        </p>
        <ul style={{ color: "var(--fc-fg-muted)", fontSize: 12, marginTop: 6, paddingLeft: 20 }}>
          <li><code>{"<workspace>/.founder-cowork/skills/"}</code></li>
          <li>VS Code globalStorage <code>/skills/</code> (user-wide)</li>
          <li>Extension bundle <code>/skills/</code> (ships with the extension)</li>
        </ul>
      </div>

      {skills && skills.length === 0 && (
        <div className="mc-empty">
          No skills found. Create <code>.founder-cowork/skills/&lt;id&gt;/SKILL.md</code>
          in your workspace and click Refresh.
        </div>
      )}

      {(["workspace", "user", "bundled"] as SkillSource[]).map((source) => {
        const list = grouped.get(source);
        if (!list || list.length === 0) return null;
        return (
          <div className="mc-card" key={source}>
            <h3 className="mc-card-title">
              <span className={"mc-pill " + sourceClass(source)}>{source}</span>
              <span style={{ marginLeft: 8 }}>
                {list.length} {list.length === 1 ? "skill" : "skills"}
              </span>
            </h3>
            <div className="mc-grid">
              {list.map((s) => {
                const key = s.source + "::" + s.id;
                const isOpen = expandedKey === key;
                const body = bodyCache[key];
                return (
                  <div
                    key={key}
                    style={{
                      border: "1px solid var(--fc-border)",
                      borderRadius: "var(--fc-radius)",
                      padding: "10px 12px",
                    }}
                  >
                    <div className="mc-row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>
                          {s.name}{" "}
                          {s.version && <span className="mc-pill">v{s.version}</span>}
                        </div>
                        <div style={{ color: "var(--fc-fg-muted)", fontSize: 12, marginTop: 2 }}>
                          <code>{s.id}</code> · modified {new Date(s.modifiedAt).toLocaleString()}
                        </div>
                        {s.description && (
                          <p style={{ margin: "6px 0 0", fontSize: 13 }}>
                            {s.description}
                          </p>
                        )}
                      </div>
                      <div className="mc-row" style={{ gap: 6 }}>
                        <button
                          className="secondary"
                          onClick={() => void toggle(s)}
                        >
                          {isOpen ? "Hide" : "View"}
                        </button>
                      </div>
                    </div>
                    {isOpen && (
                      body ? (
                        <div style={{ marginTop: 10 }}>
                          <div className="mc-row" style={{ justifyContent: "flex-end", gap: 6, marginBottom: 6 }}>
                            <button
                              className="secondary"
                              onClick={() => void copyToClipboard(body.body)}
                            >
                              Copy body
                            </button>
                            <button
                              className="secondary"
                              onClick={() => void copyToClipboard(buildPromptPrefix(body))}
                            >
                              Copy as prompt
                            </button>
                          </div>
                          <pre style={{ maxHeight: 320, overflow: "auto" }}>
                            {body.body.trim()}
                          </pre>
                        </div>
                      ) : (
                        <div className="mc-empty" style={{ marginTop: 10 }}>Loading…</div>
                      )
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {error && (
        <div className="mc-card" style={{ borderColor: "var(--fc-error)" }}>
          <h3 className="mc-card-title" style={{ color: "var(--fc-error)" }}>Error</h3>
          <pre style={{ whiteSpace: "pre-wrap", color: "var(--fc-error)" }}>{error}</pre>
        </div>
      )}
    </>
  );
}

function sourceClass(s: SkillSource): string {
  switch (s) {
    case "workspace": return "success";
    case "user":      return "";
    case "bundled":   return "warn";
  }
}

function groupBySource(list: SkillSummary[]): Map<SkillSource, SkillSummary[]> {
  const m = new Map<SkillSource, SkillSummary[]>();
  for (const s of list) {
    const arr = m.get(s.source) ?? [];
    arr.push(s);
    m.set(s.source, arr);
  }
  return m;
}

function buildPromptPrefix(body: SkillBodyResponse): string {
  const name = body.frontmatter.name ?? body.id;
  return (
    "Use the following skill (" + name + ") for this task.\n\n" +
    "---\n" +
    body.body.trim() +
    "\n---\n\n"
  );
}
