import type {
  VaultDoc,
  VaultDocBody,
  VaultListResponse,
} from "@founder-os/mission-control-protocol";
import { useEffect, useState } from "react";
import type { TabProps } from "../App.js";
import { request } from "../lib/vscode.js";

interface DraftDoc {
  id: string;
  title: string;
  tagsRaw: string;
  body: string;
}

const EMPTY_DRAFT: DraftDoc = { id: "", title: "", tagsRaw: "", body: "" };

export function VaultTab(_props: TabProps) {
  const [docs, setDocs] = useState<VaultDoc[] | null>(null);
  const [draft, setDraft] = useState<DraftDoc>(EMPTY_DRAFT);
  const [busy, setBusy] = useState<"list" | "load" | "save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    setBusy("list");
    setError(null);
    try {
      const r = await request<VaultListResponse>({ type: "vault:list" });
      setDocs(r.docs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function loadDoc(id: string): Promise<void> {
    setBusy("load");
    setError(null);
    try {
      const r = await request<VaultDocBody>({ type: "vault:read", id });
      setDraft({
        id: r.id,
        title: r.title,
        tagsRaw: r.tags.join(", "),
        body: r.body,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function saveDraft(): Promise<void> {
    if (!draft.title.trim()) return;
    setBusy("save");
    setError(null);
    try {
      const tags = draft.tagsRaw
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const saved = await request<VaultDoc>({
        type: "vault:save",
        doc: {
          id: draft.id || undefined,
          title: draft.title.trim(),
          tags,
          body: draft.body,
        },
      });
      setDraft({ ...draft, id: saved.id });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function deleteDoc(id: string): Promise<void> {
    if (!id) return;
    if (typeof window !== "undefined" && !window.confirm("Delete '" + id + "'?")) return;
    setBusy("delete");
    setError(null);
    try {
      await request({ type: "vault:delete", id });
      if (draft.id === id) setDraft(EMPTY_DRAFT);
      await refresh();
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
            Vault
          </h3>
          <div className="mc-row" style={{ gap: 6 }}>
            <button className="secondary" onClick={() => setDraft(EMPTY_DRAFT)}>
              New doc
            </button>
            <button className="secondary" onClick={refresh} disabled={busy !== null}>
              {busy === "list" ? "Loading…" : "Refresh"}
            </button>
          </div>
        </div>
        <p style={{ color: "var(--fc-fg-muted)", fontSize: 12, margin: "8px 0 0" }}>
          Wiki-style knowledge base for this venture. Stored at
          <code>{"<workspace>/.founder-cowork/vault/<id>.md"}</code>.
        </p>
      </div>

      <div
        className="mc-grid"
        style={{ gridTemplateColumns: "minmax(220px, 280px) 1fr", alignItems: "start", gap: 14 }}
      >
        <div className="mc-card" style={{ marginBottom: 0 }}>
          <h3 className="mc-card-title">Docs</h3>
          {docs === null && !error && <div className="mc-empty">Loading…</div>}
          {docs && docs.length === 0 && (
            <div className="mc-empty" style={{ padding: 16 }}>
              No docs yet.
            </div>
          )}
          {docs && docs.length > 0 && (
            <div className="mc-grid" style={{ gap: 6 }}>
              {docs.map((d) => {
                const active = d.id === draft.id;
                return (
                  <button
                    key={d.id}
                    className="secondary"
                    onClick={() => void loadDoc(d.id)}
                    style={{
                      textAlign: "left",
                      borderColor: active ? "var(--fc-accent)" : "var(--fc-border)",
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>{d.title}</div>
                    <div style={{ fontSize: 12, color: "var(--fc-fg-muted)", marginTop: 2 }}>
                      {d.tags.length > 0 && (
                        <span>
                          {d.tags.map((t) => (
                            <span key={t} className="mc-pill" style={{ marginRight: 4 }}>
                              {t}
                            </span>
                          ))}
                        </span>
                      )}
                      <span>{new Date(d.modifiedAt).toLocaleDateString()}</span>
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
              {draft.id ? "Editing: " + draft.id : "New doc"}
            </h3>
            {draft.id && (
              <button
                className="secondary"
                onClick={() => void deleteDoc(draft.id)}
                disabled={busy !== null}
              >
                Delete
              </button>
            )}
          </div>
          <div className="mc-grid" style={{ gridTemplateColumns: "auto 1fr", marginTop: 8 }}>
            <label htmlFor="vault-title">Title</label>
            <input
              id="vault-title"
              value={draft.title}
              placeholder="Doc title"
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
            <label htmlFor="vault-tags">Tags</label>
            <input
              id="vault-tags"
              value={draft.tagsRaw}
              placeholder="comma, separated, tags"
              onChange={(e) => setDraft({ ...draft, tagsRaw: e.target.value })}
            />
            <label htmlFor="vault-body" style={{ alignSelf: "start", marginTop: 6 }}>
              Body
            </label>
            <textarea
              id="vault-body"
              rows={14}
              value={draft.body}
              placeholder="Markdown body…"
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
          </div>
          <div className="mc-row" style={{ marginTop: 10, justifyContent: "flex-end" }}>
            <button onClick={saveDraft} disabled={!draft.title.trim() || busy !== null}>
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
