/**
 * VaultImportPasteScreen -- paste a chat or transcript blob into the
 * Dream Vault. Bypasses the local-file picker; the runner gets a
 * synthetic SourceDocument with sourceProvider=paste.
 *
 * Slice 9 stub: the run-vault-import helper expects an absolutePath
 * for every source. Until the Rust side adds a `vault_save_pasted_blob`
 * Tauri command, we synthesise a marker path under
 * `/_vault/_pastes/<random>.txt` and the helper's extractor port reads
 * the inline text via a side channel (the global `__VAULT_PASTES__`
 * cache below). Slice 12 swaps this for a real Tauri command.
 */
import { useEffect, useState } from "react";
import { PrivacyBanner } from "./VaultImportHubScreen.js";
import type { VaultImportSourceInput } from "../run-vault-import.js";
import type { StagedSourcePreview } from "./VaultImportLocalScreen.js";

export type VaultImportPasteScreenProps = {
  onBack: () => void;
  onStartImport: (sources: StagedSourcePreview[], jobId: string) => void;
};

declare global {
  // eslint-disable-next-line no-var
  var __VAULT_PASTES__: Map<string, string> | undefined;
}

function getPasteCache(): Map<string, string> {
  if (!globalThis.__VAULT_PASTES__) {
    globalThis.__VAULT_PASTES__ = new Map();
  }
  return globalThis.__VAULT_PASTES__;
}

function nextJobId(): string {
  return `vimp-paste-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function smellsLikeChat(text: string): boolean {
  return /^(?:You|User|Human|Assistant|Claude|ChatGPT|System|Tool|Function):/m.test(text);
}

export function VaultImportPasteScreen({ onBack, onStartImport }: VaultImportPasteScreenProps) {
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");

  useEffect(() => {
    // Surface paste-cache via window for the Tauri stub path. Cleared
    // every time the screen mounts so stale pastes from a previous
    // import don't leak in.
    getPasteCache();
  }, []);

  const canStart = text.trim().length > 0;

  const handleStart = () => {
    if (!canStart) return;
    const id = `paste-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const absolutePath = `__paste__/${id}.txt`;
    getPasteCache().set(absolutePath, text);
    const inferredTitle =
      title.trim().length > 0
        ? title.trim()
        : smellsLikeChat(text)
          ? "Pasted chat transcript"
          : "Pasted notes";
    const source: VaultImportSourceInput = {
      absolutePath,
      originalName: `${inferredTitle}.txt`,
      fileExtension: "txt",
      mimeType: "text/plain",
      sourceType: smellsLikeChat(text) ? "chat" : "document",
      byteSize: text.length,
    };
    onStartImport([source], nextJobId());
  };

  return (
    <div>
      <PrivacyBanner />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Paste content</h3>
        <button type="button" onClick={onBack} style={ghostBtn}>
          ← Back
        </button>
      </div>
      <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--text-secondary, #4B5563)" }}>
        Drop in any chat transcript, founder notes, brief, or markdown blob. We'll detect chat
        shape automatically (User:/Assistant: prefixes) and route the rest as a generic document.
      </p>

      <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
        Title <span style={{ color: "var(--text-tertiary, #9CA3AF)", fontWeight: 400 }}>(optional)</span>
      </label>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="e.g. ‘Brand kickoff with Susan’"
        style={inputStyle}
      />

      <label style={{ display: "block", fontSize: 12, fontWeight: 600, margin: "12px 0 4px" }}>
        Pasted content
      </label>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste your chat / notes / markdown here…"
        rows={12}
        style={{ ...inputStyle, resize: "vertical", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }}
      />

      <div style={{ marginTop: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "var(--text-tertiary, #6B7280)" }}>
          {text.trim().length === 0
            ? "Add some content to enable the import."
            : smellsLikeChat(text)
              ? "Detected chat-shaped transcript -- will route through the chat parser."
              : "Will route through the generic document path."}
        </span>
        <button type="button" onClick={handleStart} disabled={!canStart} style={primaryBtn}>
          Start import →
        </button>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "8px 10px",
  fontSize: 13,
  border: "1px solid var(--border-subtle, #E5E7EB)",
  borderRadius: 8,
  background: "var(--bg-surface, #FFFFFF)",
  color: "var(--text-primary, #0F172A)",
};

const primaryBtn: React.CSSProperties = {
  padding: "10px 16px",
  background: "var(--accent, #4F46E5)",
  color: "var(--accent-fg, #FFFFFF)",
  border: "1px solid transparent",
  borderRadius: 10,
  fontWeight: 700,
  fontSize: 13,
  cursor: "pointer",
};

const ghostBtn: React.CSSProperties = {
  padding: "6px 12px",
  background: "transparent",
  color: "var(--text-secondary, #4B5563)",
  border: "1px solid var(--border-subtle, #E5E7EB)",
  borderRadius: 8,
  fontSize: 12,
  cursor: "pointer",
};
