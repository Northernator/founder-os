import type {
  OllamaListModelsResponse,
  OllamaRunResponse,
} from "@founder-os/mission-control-protocol";
import { useEffect, useState } from "react";
import type { TabProps } from "../App.js";
import { request, send } from "../lib/vscode.js";

export function OllamaTab(_props: TabProps) {
  const [models, setModels] = useState<OllamaListModelsResponse | null>(null);
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [response, setResponse] = useState<OllamaRunResponse | null>(null);
  const [busy, setBusy] = useState<"models" | "run" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    setBusy("models");
    setError(null);
    try {
      const r = await request<OllamaListModelsResponse>({ type: "ollama:listModels" });
      setModels(r);
      if (!model && r.models[0]) setModel(r.models[0].name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps intentionally omitted
  useEffect(() => {
    void refresh();
  }, []);

  async function doRun(): Promise<void> {
    if (!model || !prompt.trim()) return;
    setBusy("run");
    setError(null);
    setResponse(null);
    try {
      const r = await request<OllamaRunResponse>({
        type: "ollama:run",
        model,
        prompt: prompt.trim(),
      });
      setResponse(r);
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
            Local models
          </h3>
          <div className="mc-row" style={{ gap: 6 }}>
            <button type="button" className="secondary" onClick={refresh} disabled={busy !== null}>
              {busy === "models" ? "Loading…" : "Refresh"}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() =>
                send({ type: "settings:open", query: "founderCowork.providers.ollama" })
              }
            >
              Settings
            </button>
          </div>
        </div>
        {models ? (
          models.models.length === 0 ? (
            <div className="mc-empty">
              No models pulled yet. From a terminal: <code>ollama pull llama3.1</code>
            </div>
          ) : (
            <table className="mc-table" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Size</th>
                  <th>Modified</th>
                </tr>
              </thead>
              <tbody>
                {models.models.map((m) => (
                  <tr key={m.name}>
                    <td>
                      <code>{m.name}</code>
                    </td>
                    <td>{m.sizeBytes ? `${mb(m.sizeBytes)} MB` : "—"}</td>
                    <td>{m.modifiedAt ? new Date(m.modifiedAt).toLocaleString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (
          !error && <div className="mc-empty">Loading…</div>
        )}
        {models && (
          <p style={{ color: "var(--fc-fg-muted)", fontSize: 12, margin: "8px 0 0" }}>
            Connected to <code>{models.baseUrl}</code>
          </p>
        )}
      </div>

      <div className="mc-card">
        <h3 className="mc-card-title">Generate</h3>
        <div className="mc-grid" style={{ gridTemplateColumns: "auto 1fr" }}>
          <label htmlFor="ollama-model">Model</label>
          <select
            id="ollama-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={!models || models.models.length === 0}
          >
            {models?.models.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>
          <label htmlFor="ollama-prompt" style={{ alignSelf: "start", marginTop: 6 }}>
            Prompt
          </label>
          <textarea
            id="ollama-prompt"
            placeholder="Ask the local model anything…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
          />
        </div>
        <div className="mc-row" style={{ marginTop: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={doRun}
            disabled={!model || !prompt.trim() || busy !== null}
          >
            {busy === "run" ? "Running…" : "Generate"}
          </button>
        </div>
      </div>

      {response && (
        <div className="mc-card">
          <div className="mc-row" style={{ justifyContent: "space-between" }}>
            <h3 className="mc-card-title" style={{ margin: 0 }}>
              Response — {response.model}
            </h3>
            {response.totalDurationMs !== undefined && (
              <span className="mc-pill">{response.totalDurationMs} ms</span>
            )}
          </div>
          <pre style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{response.response}</pre>
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

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(0);
}
