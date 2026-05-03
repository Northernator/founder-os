/**
 * SalesChatPanel -- interactive follow-up chat scoped to one prospect.
 *
 * Loads the most recent memory.json from the run, embeds it as context
 * in the system prompt, and lets the user ask follow-up questions
 * (refine the third email, suggest other angles, draft a one-pager,
 * etc). Streams via the existing streamChat. Picks the user's active
 * LLM provider so the experience matches the rest of Founder OS.
 *
 * Persistence: messages are written to
 *   <rootPath>/.founder/sales/chat.jsonl
 * one JSON object per line, debounced 500ms after each change.
 *
 * Cue-driven actions (mirrors BrandChatPanel pattern):
 * The assistant is instructed via the system prompt to emit a cue
 * string at the end of any message that produces save-worthy content.
 * The panel detects the cue on the latest assistant message and
 * surfaces a Save button that writes the message verbatim to a file
 * in the same run directory as memory.json. Three cues currently:
 *   SALES_ONE_PAGER_READY   -> one-pager.md
 *   SALES_PROPOSAL_READY    -> proposal.md
 *   SALES_OUTREACH_REFINED  -> refined-outreach.md
 *
 * Adding a new cue is mechanical: add to CUES, add a button.
 */

import type { Venture } from "@founder-os/domain";
import type { SalesMemory } from "@founder-os/sales-agents";
import { type ChatMessage, ProjectChat } from "@founder-os/chat-ui";
import { Button } from "@founder-os/ui";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";

import { tauriFs } from "../../lib/pipeline-fs.js";
import { pickActiveProvider, streamChat } from "../../lib/llm-client.js";
import { pushToast } from "../../lib/toasts.js";

const CHAT_REL_PATH = ".founder/sales/chat.jsonl";

/**
 * Cue definitions. Each cue is a sentinel string the assistant emits
 * at the end of a message; when detected on the most recent assistant
 * message we surface the corresponding Save button.
 */
const CUES = [
  { token: "SALES_ONE_PAGER_READY", label: "Save One-Pager", filename: "one-pager.md" },
  { token: "SALES_PROPOSAL_READY", label: "Save Proposal", filename: "proposal.md" },
  { token: "SALES_OUTREACH_REFINED", label: "Save Refined Outreach", filename: "refined-outreach.md" },
] as const;

/**
 * Clickable starter prompts. One click sends the prompt directly --
 * lighter touch than copy-pasting from the help section. The chips
 * only show when the chat is empty (returning users don't need them).
 */
const SUGGESTIONS = [
  "Make email 3 more direct.",
  "What angle should we lead with given recent funding?",
  "Draft a one-page proposal based on this intel.",
  "What weaknesses do you see in this BANT score?",
  "Suggest 2 more decision-maker roles I should target.",
] as const;

interface SalesChatPanelProps {
  venture: Venture;
  /** Path to the most recent run's memory.json. Null until pipeline ran. */
  memoryPath: string | null;
}

export function SalesChatPanel({ venture, memoryPath }: SalesChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [memory, setMemory] = useState<SalesMemory | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [savingCue, setSavingCue] = useState<string | null>(null);
  const hydratedRef = useRef(false);
  const skipPersistRef = useRef(false);
  const ctrlRef = useRef<AbortController | null>(null);

  // ---- Hydrate: load chat history + memory.json in parallel ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const chatPath = `${venture.rootPath}/${CHAT_REL_PATH}`;
      const [history, mem] = await Promise.all([
        loadChatHistory(chatPath),
        memoryPath ? loadMemory(memoryPath) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      skipPersistRef.current = true;
      setMessages(history);
      setMemory(mem);
      hydratedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [venture.rootPath, memoryPath]);

  // ---- Persist: write chat.jsonl debounced 500ms after change ----
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (skipPersistRef.current) {
      skipPersistRef.current = false;
      return;
    }
    const t = setTimeout(() => {
      const chatPath = `${venture.rootPath}/${CHAT_REL_PATH}`;
      void persistChatHistory(chatPath, messages);
    }, 500);
    return () => clearTimeout(t);
  }, [messages, venture.rootPath]);

  // ---- Cancel any in-flight stream on unmount ----
  useEffect(() => {
    return () => {
      ctrlRef.current?.abort();
    };
  }, []);

  // ---- Cue detection: scan most recent assistant message ----
  const activeCues = useMemo(() => {
    return CUES.filter((c) => lastAssistantIncludes(messages, c.token));
  }, [messages]);

  // ---- Edge-detect cue activations -> one-shot toast ----
  const prevActiveRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = new Set(activeCues.map((c) => c.token));
    for (const c of activeCues) {
      if (!prevActiveRef.current.has(c.token)) {
        pushToast({
          kind: "info",
          message: `Save action available: ${c.label}`,
        });
      }
    }
    prevActiveRef.current = now;
  }, [activeCues]);

  async function handleSend(content: string): Promise<void> {
    if (!content.trim() || streaming) return;
    const provider = await pickActiveProvider(venture.id);
    if (!provider) {
      pushToast({
        kind: "error",
        message: "No LLM provider configured -- pick one in Options.",
      });
      return;
    }

    const userMsg: ChatMessage = {
      id: makeId(),
      role: "user",
      content: content.trim(),
      createdAt: new Date().toISOString(),
    };
    const assistantId = makeId();
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      provider,
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setStreaming(true);

    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    try {
      await streamChat({
        provider,
        system: buildSystemPrompt(memory),
        messages: [
          ...messages.map((m) => ({ role: m.role, content: m.content })),
          { role: "user", content: userMsg.content },
        ],
        temperature: 0.7,
        maxTokens: 1500,
        signal: ctrl.signal,
        onDelta: (delta) => {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + delta } : m)),
          );
        },
      });
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (!isAbort) {
        const msg = err instanceof Error ? err.message : String(err);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: m.content + `\n\n[error: ${msg}]` } : m,
          ),
        );
        pushToast({ kind: "error", message: `Chat failed: ${msg.slice(0, 120)}` });
      }
    } finally {
      setStreaming(false);
      ctrlRef.current = null;
    }
  }

  /**
   * Save the latest assistant message verbatim to a file in the run
   * directory (next to memory.json). Strips the cue token from the
   * tail of the message so the saved file does not include it.
   */
  async function handleSaveAction(cue: typeof CUES[number]): Promise<void> {
    if (!memoryPath || savingCue) return;
    const last = lastAssistantMessage(messages);
    if (!last) {
      pushToast({ kind: "error", message: "No assistant reply to save." });
      return;
    }
    setSavingCue(cue.token);
    try {
      const runDir = parentDir(memoryPath);
      const outPath = `${runDir}/${cue.filename}`;
      const cleaned = stripCueTokens(last.content);
      await invoke("mkdir_p", { path: runDir });
      await tauriFs.writeFile(outPath, cleaned);
      pushToast({ kind: "success", message: `Saved: ${cue.filename}` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pushToast({ kind: "error", message: `Save failed: ${msg.slice(0, 120)}` });
    } finally {
      setSavingCue(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: "0.5rem" }}>
      {messages.length === 0 && memoryPath && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.4rem",
            padding: "0.5rem",
            background: "rgba(0,0,0,0.03)",
            borderRadius: "0.4rem",
            fontSize: "0.85rem",
          }}
        >
          <span style={{ alignSelf: "center", opacity: 0.75, marginRight: "0.25rem" }}>
            Try:
          </span>
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => void handleSend(s)}
              disabled={streaming}
              style={{
                background: "white",
                border: "1px solid var(--border-subtle, #e2e8f0)",
                borderRadius: "999px",
                padding: "0.3rem 0.7rem",
                fontSize: "0.8rem",
                cursor: "pointer",
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}
      {activeCues.length > 0 && memoryPath && (
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            flexWrap: "wrap",
            padding: "0.5rem",
            background: "var(--accent-soft, rgba(37, 99, 235, 0.08))",
            borderRadius: "0.4rem",
            fontSize: "0.85rem",
          }}
        >
          <span style={{ alignSelf: "center", opacity: 0.85 }}>
            Detected cues from the assistant:
          </span>
          {activeCues.map((c) => (
            <Button
              key={c.token}
              onClick={() => void handleSaveAction(c)}
              disabled={savingCue !== null}
            >
              {savingCue === c.token ? "Saving..." : c.label}
            </Button>
          ))}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        <ProjectChat
          ventureId={venture.id}
          ventureName={venture.name}
          currentStage={venture.stage}
          messages={messages}
          isLoading={streaming}
          onSend={handleSend}
          placeholder={
            memoryPath
              ? "Ask a follow-up about this prospect..."
              : "Run the pipeline first, then chat about the results..."
          }
        />
      </div>
    </div>
  );
}

// ---- Helpers ----

function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function lastAssistantIncludes(messages: ChatMessage[], needle: string): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    return m.content.includes(needle);
  }
  return false;
}

function lastAssistantMessage(messages: ChatMessage[]): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant") return m;
  }
  return null;
}

function stripCueTokens(content: string): string {
  let out = content;
  for (const c of CUES) {
    // Strip standalone-line cue tokens at the end of the message.
    const re = new RegExp(`\\s*\\n?\\s*${c.token}\\s*$`);
    out = out.replace(re, "").trimEnd();
  }
  return `${out}\n`;
}

function parentDir(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx === -1 ? "." : norm.slice(0, idx);
}

function buildSystemPrompt(memory: SalesMemory | null): string {
  const base =
    "You are a sales strategy advisor helping a founder follow up on a prospect. " +
    "Be concise and concrete. Reference specifics from the intel below. When the " +
    "founder asks for a rewrite, return only the rewritten content (no preamble).";
  const cuesDoc = [
    "",
    "ACTION CUES",
    "===========",
    "When you have just produced complete content the founder might want to save",
    "as a file, end your message with EXACTLY ONE of these tokens on its own",
    "final line. The desktop app detects the token and surfaces a Save button.",
    "",
    "  SALES_ONE_PAGER_READY     -- when you have produced a one-page summary",
    "  SALES_PROPOSAL_READY      -- when you have drafted a formal proposal",
    "  SALES_OUTREACH_REFINED    -- when you have rewritten the outreach sequence",
    "",
    "Only emit a cue if the message body actually contains the corresponding",
    "saveable content. Do NOT emit cues for short answers, clarifications, or",
    "questions back to the founder. The token is stripped before saving.",
  ].join("\n");

  if (!memory || Object.keys(memory).length === 0) {
    return `${base}\n\n(No prospect intel loaded yet -- guide the founder to run the pipeline first.)\n${cuesDoc}`;
  }
  const c = memory.research?.company ?? {};
  const bant = memory.bant;
  const dms = memory.decisionMakers?.contacts ?? [];
  const intel = memory.competitiveIntel;
  const emails = memory.outreach?.emails ?? [];

  const lines = [
    base,
    "",
    "PROSPECT INTEL",
    "==============",
    `Company: ${c.name ?? "?"} (${c.industry ?? "?"}, ${c.employees ?? "?"} employees, founded ${c.founded ?? "?"})`,
    `Differentiators: ${c.differentiators ?? "n/a"}`,
    c.recentNews ? `Recent news: ${c.recentNews}` : "",
    "",
    `BANT fit: ${bant?.fitScore ?? "?"}/100 -- B${bant?.scores?.budget ?? "?"} A${bant?.scores?.authority ?? "?"} N${bant?.scores?.need ?? "?"} T${bant?.scores?.timeline ?? "?"}`,
    bant?.reasoning ? `BANT reasoning: ${bant.reasoning}` : "",
    "",
    `Decision makers: ${dms.length ? dms.map((d) => `${d.title} (${d.department ?? "?"})`).join("; ") : "(none identified)"}`,
    "",
    `Competitors: ${intel?.competitors?.length ? intel.competitors.map((cm) => `${cm.name} -- ${cm.advantage}`).join("; ") : "(none)"}`,
    intel?.opportunity ? `Opportunity: ${intel.opportunity}` : "",
    "",
    "Drafted outreach:",
    ...emails.map((e, i) => `  ${i + 1}. "${e.subject}"`),
    cuesDoc,
  ];
  return lines.filter((l) => l !== "").join("\n");
}

async function loadChatHistory(path: string): Promise<ChatMessage[]> {
  try {
    const exists = await tauriFs.exists(path);
    if (!exists) return [];
    const raw = await tauriFs.readFile(path);
    const out: ChatMessage[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as ChatMessage;
        if (msg.id && msg.role && typeof msg.content === "string") out.push(msg);
      } catch {
        // skip malformed lines
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function persistChatHistory(path: string, messages: ChatMessage[]): Promise<void> {
  try {
    const norm = path.replace(/\\/g, "/");
    const idx = norm.lastIndexOf("/");
    const dir = idx === -1 ? "" : norm.slice(0, idx);
    if (dir) await invoke("mkdir_p", { path: dir });
    const body = messages.map((m) => JSON.stringify(m)).join("\n") + (messages.length ? "\n" : "");
    await tauriFs.writeFile(path, body);
  } catch {
    // ephemeral-friendly
  }
}

async function loadMemory(memoryPath: string): Promise<SalesMemory | null> {
  try {
    const exists = await tauriFs.exists(memoryPath);
    if (!exists) return null;
    const raw = await tauriFs.readFile(memoryPath);
    return JSON.parse(raw) as SalesMemory;
  } catch {
    return null;
  }
}
