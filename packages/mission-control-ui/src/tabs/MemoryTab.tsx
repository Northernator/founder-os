import type {
  MemoryEntry,
  MemoryEntryBody,
  MemoryListResponse,
  MemoryType,
} from "@founder-os/mission-control-protocol";
import { useEffect, useState } from "react";
import type { TabProps } from "../App.js";
import { request } from "../lib/vscode.js";

const MEMORY_TYPES: MemoryType[] = ["user", "feedback", "project", "reference"];

interface DraftEntry {
  id: string; // empty = new
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

const EMPTY_DRAFT: DraftEntry = {
  id: "",
  name: "",
  description: "",
  type: "user",
  body: "",
};

export function MemoryTab(_props: TabProps) {
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [draft, setDraft] = useState<DraftEntry>(EMPTY_DRAFT);
  const [busy, setBusy] = useState<"list" | "load" | "save" | "delete" | "snap" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    setBusy("list");
    setError(null);
    try {
      const r = await request<MemoryListResponse>({ type: "memory:list" });
      setEntries(r.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function loadEntry(id: string): Promise<void> {
    setBusy("load");
    setError(null);
    try {
      const r = await request<MemoryEntryBody>({ type: "memory:read", id });
      setDraft({
        id: r.id,
        name: r.name,
        description: r.description,
        type: r.type,
        body: r.body,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function saveDraft(): Promise<void> {
    if (!draft.name.trim()) return;
    setBusy("save");
    setError(null);
    try {
      const saved = await request<MemoryEntry>({
        type: "memory:save",
        entry: {
          id: draft.id || undefined,
          name: draft.name.trim(),
          description: draft.description.trim(),
          type: draft.type,
          body: draft.body,
        },
      });
      setDraft({
        id: saved.id,
        name: saved.name,
        description: saved.description,
        type: saved.type,
        body: draft.body,
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function deleteEntry(id: string): Promise<void> {
    if (!id) return;
    if (typeof window !== "undefined" && !window.confirm("Delete '" + id + "'?")) return;
    setBusy("delete");
    setError(null);
    try {
      await request({ type: "memory:delete", id });
      if (draft.id === id) setDraft(EMPTY_DRAFT);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function snapshotCurrent(): Promise<void> {
    setBusy("snap");
    setError(null);
    try {
      const saved = await request<MemoryEntry>({ type: "memory:saveCurrent" });
      await refresh();
      await loadEntry(saved.id);
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
          <h3 className="mc-card-title" style={{ margin: 0 }}>
            Memory
          </h3>
          <div className="mc-row" style={{ gap: 6 }}>
            <button className="secondary" onClick={() => setDraft(EMPTY_DRAFT)}>
              New entry
            </button>
            <button className="secondary" onClick={snapshotCurrent} disabled={busy !== null}>
              {busy === "snap" ? "Snapshotting…" : "Snapshot active editor"}
            </button>
            <button className="secondary" onClick={refresh} disabled={busy !== null}>
              {busy === "list" ? "Loading…" : "Refresh"}
            </button>
          </div>
        </div>
        <p style={{ color: "var(--fc-fg-muted)", fontSize: 12, margin: "8px 0 0" }}>
          Stored at <code>{"<workspace>/.founder-cowork/memory/<id>.md"}</code>. Phase 4 swaps this
          for InsForge-backed storage behind the same shape.
        </p>
      </div>

      <div
        className="mc-grid"
        style={{ gridTemplateColumns: "minmax(220px, 280px) 1fr", alignItems: "start", gap: 14 }}
      >
        <div className="mc-card" style={{ marginBottom: 0 }}>
          <h3 className="mc-card-title">Entries</h3>
          {entries === null && !error && <div className="mc-empty">Loading…</div>}
          {entries && entries.length === 0 && (
            <div className="mc-empty" style={{ padding: 16 }}>
              No entries yet. Create one in the editor on the right.
            </div>
          )}
          {entries && entries.length > 0 && (
            <div className="mc-grid" style={{ gap: 6 }}>
              {entries.map((e) => {
                const active = e.id === draft.id;
                return (
                  <button
                    key={e.id}
                    className="secondary"
                    onClick={() => void loadEntry(e.id)}
                    style={{
                      textAlign: "left",
                      borderColor: active ? "var(--fc-accent)" : "var(--fc-border)",
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>{e.name}</div>
                    <div style={{ fontSize: 12, color: "var(--fc-fg-muted)", marginTop: 2 }}>
                      <span className="mc-pill">{e.type}</span>{" "}
                      <span>{new Date(e.modifiedAt).toLocaleDateString()}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="mc-card" style={{ marginBottom: 0 }}>
          <div className="mc-row" style={{ justifyContent: "space-between" }}>
            <h3 className="mc-card-title" style={{ margin: 0 }}>
              {draft.id ? "Editing: " + draft.id : "New entry"}
            </h3>
            {draft.id && (
              <button
                className="secondary"
                onClick={() => void deleteEntry(draft.id)}
                disabled={busy !== null}
              >
                Delete
              </button>
            )}
          </div>
          <div className="mc-grid" style={{ gridTemplateColumns: "auto 1fr", marginTop: 8 }}>
            <label htmlFor="mem-name">Name</label>
            <input
              id="mem-name"
              value={draft.name}
              placeholder="Short title"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <label htmlFor="mem-desc">Description</label>
            <input
              id="mem-desc"
              value={draft.description}
              placeholder="One-liner used to decide relevance later"
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
            <label htmlFor="mem-type">Type</label>
            <select
              id="mem-type"
              value={draft.type}
              onChange={(e) => setDraft({ ...draft, type: e.target.value as MemoryType })}
            >
              {MEMORY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <label htmlFor="mem-body" style={{ alignSelf: "start", marginTop: 6 }}>
              Body
            </label>
            <textarea
              id="mem-body"
              rows={10}
              value={draft.body}
              placeholder="Markdown body. For feedback/project: include Why: and How to apply: lines."
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
          </div>
          <div className="mc-row" style={{ marginTop: 10, justifyContent: "flex-end" }}>
            <button onClick={saveDraft} disabled={!draft.name.trim() || busy !== null}>
              {busy === "save" ? "Saving…" : draft.id ? "Save" : "Create"}
            </button>
          </div>
        </div>
      </div>

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
