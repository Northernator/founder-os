/**
 * ResearchChatPanel -- CLI-style chat that fires research-py jobs and
 * watches them complete. Mirrors the BrandChatPanel pattern (slash
 * commands, host callbacks for open-on-disk, JSONL persistence under
 * the venture root).
 *
 * Scope (v0.1):
 *   /deep <topic>             -- POST /research/deep
 *   /competitors <u1> <u2>... -- POST /research/competitors
 *   /jobs                     -- GET  /research/jobs (newest first)
 *   /clear                    -- wipe in-memory chat (history file untouched)
 *   /help                     -- list commands
 *
 * Persistence: <root>/01_research/chat.jsonl, one JSON per line. Same
 * write-debounced + skipPersistRef hydration pattern as BrandChatPanel.
 *
 * Backend: defaults to http://localhost:3030 (the docker-compose port
 * for services/research-py). Override via the `baseUrl` prop -- a
 * future slice can wire that from OptionsTab.
 */

import type { Venture } from "@founder-os/domain";
import {
  type CompetitorBreakdown,
  type CompetitorScanResult,
  type DeepResearchResult,
  type IcpPersonaSummary,
  type IcpResult,
  type JobRecord,
  ResearchClient,
  ResearchClientError,
  pollJob,
} from "@founder-os/research-runner";
import { invoke } from "@tauri-apps/api/core";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pushToast } from "../../lib/toasts.js";
import { joinPath } from "../../lib/venture-io.js";

const DEFAULT_BASE_URL = "http://localhost:3030";
const CHAT_HISTORY_REL_DIR = "01_research";
const CHAT_HISTORY_FILE = "chat.jsonl";
const POLL_INTERVAL_MS = 3000;
const DEEP_TIMEOUT_MS = 15 * 60_000;        // GPT-Researcher can be slow
const COMPETITORS_TIMEOUT_MS = 20 * 60_000; // 20 URLs * scrape latency

// ----------------------------- types -----------------------------

type ChatRole = "user" | "assistant" | "system";

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  ts: number;
  /** Set on assistant messages that started a job. Updated to the
   *  final progress message once the job ends. */
  jobId?: string;
  /** Latest job status known when this message was last updated. */
  jobStatus?: JobRecord["status"];
  /** Final result for completed /deep runs. */
  deepResult?: DeepResearchResult;
  /** Final result for completed /competitors runs. */
  competitorResult?: CompetitorScanResult;
  /** Snapshot from /jobs. */
  jobsList?: JobRecord[];
  /** Final result for completed /icp runs. */
  icpResult?: IcpResult;
  /** Free-text error captured when a command fails before reaching
   *  the live-progress phase (e.g. validation 400). */
  errorText?: string;
};

// ----------------------------- helpers -----------------------------

function makeId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function chatHistoryPath(rootPath: string): string {
  return joinPath(joinPath(rootPath, CHAT_HISTORY_REL_DIR), CHAT_HISTORY_FILE);
}

async function loadChatHistory(rootPath: string): Promise<ChatMessage[]> {
  try {
    const raw = await invoke<string>("read_file", { path: chatHistoryPath(rootPath) });
    const out: ChatMessage[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (
          parsed &&
          typeof parsed.id === "string" &&
          typeof parsed.role === "string" &&
          typeof parsed.content === "string"
        ) {
          out.push(parsed as ChatMessage);
        }
      } catch {
        // skip
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function persistChatHistory(rootPath: string, messages: readonly ChatMessage[]): Promise<void> {
  try {
    await invoke("mkdir_p", { path: joinPath(rootPath, CHAT_HISTORY_REL_DIR) });
    const jsonl = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    await invoke("write_file", { path: chatHistoryPath(rootPath), content: jsonl });
  } catch (err) {
    console.warn("[research-chat] persistChatHistory failed", err);
  }
}

function tokenize(rest: string): string[] {
  return rest.split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

function shortError(err: unknown): string {
  if (err instanceof ResearchClientError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function ts(record: JobRecord): string {
  try {
    return new Date(record.updated_at).toLocaleTimeString();
  } catch {
    return record.updated_at;
  }
}

const HELP_TEXT = [
  "Research chat commands:",
  "  /deep <topic>             Kick off a deep-research job (GPT-Researcher).",
  "  /competitors <url> ...    Scan one or more competitor sites (1-20 URLs).",
  "  /icp                      Synthesise an ICP from existing 01_research/ artifacts.",
  "  /jobs                     List recent jobs and their status.",
  "  /clear                    Clear the chat from this view (history kept on disk).",
  "  /help                     Show this list.",
  "",
  "Anything that doesn't start with / is treated as prose and is not sent to the model.",
].join("\n");

// ----------------------------- component -----------------------------

export function ResearchChatPanel(props: {
  venture: Venture;
  /** Override the research-py base URL. Defaults to http://localhost:3030.
   *  Wire this to OptionsTab in a future slice. */
  baseUrl?: string;
}) {
  const { venture } = props;
  const baseUrl = props.baseUrl ?? DEFAULT_BASE_URL;

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: makeId(),
      role: "system",
      content:
        "Research chat (research-py, v0.1). Type /help for commands. " +
        "/deep and /competitors run async jobs and stream progress updates here.",
      ts: Date.now(),
    },
  ]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);

  // Hydration plumbing -- same pattern as BrandChatPanel.
  const hydratedRef = useRef(false);
  const skipPersistRef = useRef(false);
  // Active polling abort controllers keyed by message id -- /clear
  // aborts every live job so the loops don't keep updating ghost
  // messages.
  const activeAbortsRef = useRef<Map<string, AbortController>>(new Map());

  // Memoised client per baseUrl. Cheap to recreate, but keeps
  // referential stability for useCallback deps.
  const client = useMemo(() => new ResearchClient({ baseUrl }), [baseUrl]);

  // ---- hydrate ----
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded = await loadChatHistory(venture.rootPath);
      if (cancelled) return;
      if (loaded.length > 0) {
        skipPersistRef.current = true;
        setMessages(loaded);
      }
      hydratedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [venture.rootPath]);

  // ---- persist (debounced) ----
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (skipPersistRef.current) {
      skipPersistRef.current = false;
      return;
    }
    if (messages.length <= 1) return;
    const t = setTimeout(() => {
      void persistChatHistory(venture.rootPath, messages);
    }, 500);
    return () => clearTimeout(t);
  }, [messages, venture.rootPath]);

  // ---- abort all active jobs on unmount ----
  useEffect(() => {
    const active = activeAbortsRef.current;
    return () => {
      for (const ctrl of active.values()) ctrl.abort();
      active.clear();
    };
  }, []);

  // ---- helpers ----

  const append = useCallback(
    (role: ChatRole, content: string, extra: Partial<ChatMessage> = {}): string => {
      const id = makeId();
      setMessages((m) => [...m, { id, role, content, ts: Date.now(), ...extra }]);
      return id;
    },
    [],
  );

  const updateMessage = useCallback((id: string, patch: Partial<ChatMessage>) => {
    setMessages((m) => m.map((msg) => (msg.id === id ? { ...msg, ...patch } : msg)));
  }, []);

  // ---- /deep ----
  const handleDeep = useCallback(
    async (rest: string) => {
      const topic = rest.trim();
      if (!topic) {
        append("system", "Usage: /deep <topic>");
        return;
      }
      const messageId = append(
        "assistant",
        `Starting deep research: "${topic}" -- queued.`,
        { jobStatus: "queued" },
      );

      let jobId: string;
      try {
        const accepted = await client.createDeepResearch({
          venture_slug: venture.id,
          topic,
          depth: 2,
        });
        jobId = accepted.job_id;
        updateMessage(messageId, {
          jobId,
          content: `Deep research job ${jobId.slice(0, 8)} queued for "${topic}".`,
        });
      } catch (err) {
        updateMessage(messageId, {
          content: `Failed to start deep research: ${shortError(err)}`,
          jobStatus: "error",
          errorText: shortError(err),
        });
        return;
      }

      const controller = new AbortController();
      activeAbortsRef.current.set(messageId, controller);

      const outcome = await pollJob(client, jobId, {
        intervalMs: POLL_INTERVAL_MS,
        timeoutMs: DEEP_TIMEOUT_MS,
        signal: controller.signal,
        onProgress: (rec) => {
          updateMessage(messageId, {
            jobStatus: rec.status,
            content: `[${ts(rec)}] ${rec.status}: ${rec.progress_message}  (job ${rec.job_id.slice(0, 8)})`,
          });
        },
      });
      activeAbortsRef.current.delete(messageId);

      if (outcome.kind === "done" && outcome.record.result) {
        const result = outcome.record.result as unknown as DeepResearchResult;
        updateMessage(messageId, {
          jobStatus: "done",
          content: `Deep research done. ${result.summary_md_chars.toLocaleString()} chars, ${result.sources_count} sources.`,
          deepResult: result,
        });
      } else if (outcome.kind === "error") {
        updateMessage(messageId, {
          jobStatus: "error",
          content: `Deep research failed: ${outcome.record.error ?? "(no error message)"}`,
          errorText: outcome.record.error ?? undefined,
        });
      } else if (outcome.kind === "timeout") {
        updateMessage(messageId, {
          jobStatus: "running",
          content: `Polling timed out. Job ${jobId.slice(0, 8)} may still be running -- run /jobs to check.`,
        });
      } else if (outcome.kind === "aborted") {
        updateMessage(messageId, {
          content: `Polling aborted. Job ${jobId.slice(0, 8)} may still be running on the server.`,
        });
      }
    },
    [append, client, updateMessage, venture.id],
  );

  // ---- /competitors ----
  const handleCompetitors = useCallback(
    async (rest: string) => {
      const urls = tokenize(rest);
      if (urls.length === 0) {
        append("system", "Usage: /competitors <url1> <url2> ...");
        return;
      }
      if (urls.length > 20) {
        append("system", `Too many URLs (${urls.length}); the server caps the list at 20.`);
        return;
      }
      const messageId = append(
        "assistant",
        `Starting competitor scan over ${urls.length} URL(s) -- queued.`,
        { jobStatus: "queued" },
      );

      let jobId: string;
      try {
        const accepted = await client.scanCompetitors({
          venture_slug: venture.id,
          urls,
        });
        jobId = accepted.job_id;
        updateMessage(messageId, {
          jobId,
          content: `Competitor scan job ${jobId.slice(0, 8)} queued for ${urls.length} URL(s).`,
        });
      } catch (err) {
        updateMessage(messageId, {
          content: `Failed to start competitor scan: ${shortError(err)}`,
          jobStatus: "error",
          errorText: shortError(err),
        });
        return;
      }

      const controller = new AbortController();
      activeAbortsRef.current.set(messageId, controller);

      const outcome = await pollJob(client, jobId, {
        intervalMs: POLL_INTERVAL_MS,
        timeoutMs: COMPETITORS_TIMEOUT_MS,
        signal: controller.signal,
        onProgress: (rec) => {
          updateMessage(messageId, {
            jobStatus: rec.status,
            content: `[${ts(rec)}] ${rec.status}: ${rec.progress_message}  (job ${rec.job_id.slice(0, 8)})`,
          });
        },
      });
      activeAbortsRef.current.delete(messageId);

      if (outcome.kind === "done" && outcome.record.result) {
        const result = outcome.record.result as unknown as CompetitorScanResult;
        updateMessage(messageId, {
          jobStatus: "done",
          content: `Competitor scan done. ${result.competitor_count} competitor(s), ${result.pricing_rows_total} pricing row(s).`,
          competitorResult: result,
        });
      } else if (outcome.kind === "error") {
        updateMessage(messageId, {
          jobStatus: "error",
          content: `Competitor scan failed: ${outcome.record.error ?? "(no error message)"}`,
          errorText: outcome.record.error ?? undefined,
        });
      } else if (outcome.kind === "timeout") {
        updateMessage(messageId, {
          jobStatus: "running",
          content: `Polling timed out. Job ${jobId.slice(0, 8)} may still be running -- run /jobs to check.`,
        });
      } else if (outcome.kind === "aborted") {
        updateMessage(messageId, {
          content: `Polling aborted. Job ${jobId.slice(0, 8)} may still be running on the server.`,
        });
      }
    },
    [append, client, updateMessage, venture.id],
  );

  // ---- /icp ----
  const handleIcp = useCallback(async () => {
    const messageId = append(
      "assistant",
      "Starting ICP synthesis -- queued.",
      { jobStatus: "queued" },
    );

    let jobId: string;
    try {
      const accepted = await client.synthesizeIcp({ venture_slug: venture.id });
      jobId = accepted.job_id;
      updateMessage(messageId, {
        jobId,
        content: `ICP synthesis job ${jobId.slice(0, 8)} queued.`,
      });
    } catch (err) {
      updateMessage(messageId, {
        content: `Failed to start ICP synthesis: ${shortError(err)}`,
        jobStatus: "error",
        errorText: shortError(err),
      });
      return;
    }

    const controller = new AbortController();
    activeAbortsRef.current.set(messageId, controller);

    const outcome = await pollJob(client, jobId, {
      intervalMs: POLL_INTERVAL_MS,
      timeoutMs: DEEP_TIMEOUT_MS,
      signal: controller.signal,
      onProgress: (rec) => {
        updateMessage(messageId, {
          jobStatus: rec.status,
          content: `[${ts(rec)}] ${rec.status}: ${rec.progress_message}  (job ${rec.job_id.slice(0, 8)})`,
        });
      },
    });
    activeAbortsRef.current.delete(messageId);

    if (outcome.kind === "done" && outcome.record.result) {
      const result = outcome.record.result as unknown as IcpResult;
      updateMessage(messageId, {
        jobStatus: "done",
        content: `ICP done. ${result.personas_count} persona(s) from ${result.input_count} input artifact(s).`,
        icpResult: result,
      });
    } else if (outcome.kind === "error") {
      updateMessage(messageId, {
        jobStatus: "error",
        content: `ICP synthesis failed: ${outcome.record.error ?? "(no error message)"}`,
        errorText: outcome.record.error ?? undefined,
      });
    } else if (outcome.kind === "timeout") {
      updateMessage(messageId, {
        jobStatus: "running",
        content: `Polling timed out. Job ${jobId.slice(0, 8)} may still be running -- run /jobs to check.`,
      });
    } else if (outcome.kind === "aborted") {
      updateMessage(messageId, {
        content: `Polling aborted. Job ${jobId.slice(0, 8)} may still be running on the server.`,
      });
    }
  }, [append, client, updateMessage, venture.id]);

  // ---- /jobs ----
  const handleJobs = useCallback(async () => {
    const messageId = append("assistant", "Loading recent jobs...");
    try {
      const list = await client.listJobs();
      const jobs = list.jobs.slice(0, 20);
      const summary = jobs.length === 0
        ? "No jobs yet -- /deep or /competitors will create some."
        : `Showing ${jobs.length} most recent job(s).`;
      updateMessage(messageId, { content: summary, jobsList: jobs });
    } catch (err) {
      updateMessage(messageId, {
        content: `Failed to list jobs: ${shortError(err)}`,
        errorText: shortError(err),
      });
    }
  }, [append, client, updateMessage]);

  // ---- /clear ----
  const handleClear = useCallback(() => {
    for (const ctrl of activeAbortsRef.current.values()) ctrl.abort();
    activeAbortsRef.current.clear();
    setMessages([
      {
        id: makeId(),
        role: "system",
        content: "Cleared. (Disk history at 01_research/chat.jsonl is untouched -- it will be rewritten on next message.)",
        ts: Date.now(),
      },
    ]);
  }, []);

  // ---- dispatch ----
  const handleSlash = useCallback(
    async (raw: string) => {
      const space = raw.indexOf(" ");
      const cmd = (space === -1 ? raw : raw.slice(0, space)).toLowerCase();
      const rest = space === -1 ? "" : raw.slice(space + 1);

      if (cmd === "/help") {
        append("system", HELP_TEXT);
        return;
      }
      if (cmd === "/deep") {
        await handleDeep(rest);
        return;
      }
      if (cmd === "/competitors") {
        await handleCompetitors(rest);
        return;
      }
      if (cmd === "/icp") {
        await handleIcp();
        return;
      }
      if (cmd === "/jobs") {
        await handleJobs();
        return;
      }
      if (cmd === "/clear") {
        handleClear();
        return;
      }
      append("system", `Unknown command: ${cmd}. Type /help for the list.`);
    },
    [append, handleClear, handleCompetitors, handleDeep, handleIcp, handleJobs],
  );

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    append("user", text);
    if (!text.startsWith("/")) {
      append(
        "system",
        "Plain prose isn't sent anywhere yet -- only slash commands trigger jobs. Type /help.",
      );
      return;
    }
    setRunning(true);
    try {
      await handleSlash(text);
    } finally {
      setRunning(false);
    }
  }, [append, handleSlash, input]);

  // ---- open helpers (rendered as buttons inside cards) ----

  const openPath = useCallback(async (path: string) => {
    try {
      await invoke("open_path", { path });
    } catch (err) {
      pushToast({
        kind: "warn",
        message: "Could not open path",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  // ---- render ----

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          maxHeight: 480,
          overflowY: "auto",
          padding: 12,
          border: "1px solid var(--border-subtle)",
          borderRadius: 8,
          background: "var(--bg-elevated)",
        }}
      >
        {messages.map((m) => (
          <MessageRow key={m.id} m={m} onOpenPath={openPath} />
        ))}
        {messages.length <= 1 && (
          <div style={{ color: "var(--text-muted)", fontStyle: "italic", padding: 4 }}>
            No commands yet. Try <code>/deep AI coding assistants 2026</code> or
            <code> /competitors https://linear.app https://raycast.com</code>.
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!running) void handleSend();
            }
          }}
          placeholder="/help or /deep <topic> or /competitors <url> ..."
          spellCheck={false}
          style={{
            flex: 1,
            padding: "8px 10px",
            border: "1px solid var(--border-subtle)",
            borderRadius: 6,
            background: "var(--bg-input)",
            color: "var(--text-primary)",
            fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
            fontSize: 13,
          }}
        />
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={running || !input.trim()}
          style={{
            padding: "8px 14px",
            borderRadius: 6,
            border: "1px solid var(--border-subtle)",
            background: running ? "var(--bg-hover)" : "var(--accent)",
            color: running ? "var(--text-muted)" : "var(--accent-text, #fff)",
            cursor: running || !input.trim() ? "not-allowed" : "pointer",
            fontWeight: 600,
            fontSize: 13,
          }}
        >
          {running ? "..." : "Send"}
        </button>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
        Backend: <code>{baseUrl}</code> -- override per-venture in a future Options slice.
      </div>
    </div>
  );
}

// ----------------------------- message row -----------------------------

const STATUS_COLOR: Record<JobRecord["status"], string> = {
  queued: "var(--text-tertiary)",
  running: "var(--info, #4cb1f1)",
  done: "var(--success, #4ade80)",
  error: "var(--danger, #f87171)",
};

function MessageRow(props: { m: ChatMessage; onOpenPath: (p: string) => void }) {
  const { m, onOpenPath } = props;
  const roleStyle: React.CSSProperties =
    m.role === "user"
      ? { color: "var(--text-primary)", fontWeight: 600 }
      : m.role === "system"
      ? { color: "var(--text-tertiary)", fontStyle: "italic" }
      : { color: "var(--text-secondary)" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <span
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            color: "var(--text-muted)",
            minWidth: 56,
          }}
        >
          {m.role}
        </span>
        {m.jobStatus && (
          <span
            style={{
              fontSize: 10,
              padding: "1px 6px",
              borderRadius: 4,
              border: `1px solid ${STATUS_COLOR[m.jobStatus]}`,
              color: STATUS_COLOR[m.jobStatus],
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            {m.jobStatus}
          </span>
        )}
        <span style={{ ...roleStyle, whiteSpace: "pre-wrap", fontSize: 13, flex: 1 }}>
          {m.content}
        </span>
      </div>
      {m.errorText && (
        <pre
          style={{
            margin: "0 0 0 64px",
            padding: 8,
            background: "var(--bg-input)",
            border: "1px solid var(--danger, #f87171)",
            borderRadius: 6,
            color: "var(--danger, #f87171)",
            fontSize: 12,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {m.errorText}
        </pre>
      )}
      {m.deepResult && (
        <DeepResultCard result={m.deepResult} onOpenPath={onOpenPath} />
      )}
      {m.competitorResult && (
        <CompetitorResultCard result={m.competitorResult} onOpenPath={onOpenPath} />
      )}
      {m.icpResult && (
        <IcpResultCard result={m.icpResult} onOpenPath={onOpenPath} />
      )}
      {m.jobsList && <JobsListCard jobs={m.jobsList} />}
    </div>
  );
}

function DeepResultCard(props: {
  result: DeepResearchResult;
  onOpenPath: (p: string) => void;
}) {
  const { result, onOpenPath } = props;
  return (
    <div
      style={{
        marginLeft: 64,
        padding: 10,
        background: "var(--bg-panel)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
        Wrote <code>{result.summary_md_chars.toLocaleString()}</code> chars,
        <code> {result.sources_count}</code> sources.
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => onOpenPath(result.output_path)}
          style={openButtonStyle}
        >
          Open research-summary.md
        </button>
        <button
          type="button"
          onClick={() => onOpenPath(result.sources_path)}
          style={openButtonStyle}
        >
          Open sources.json
        </button>
      </div>
      {result.sources.length > 0 && (
        <details style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
          <summary style={{ cursor: "pointer" }}>
            Sources ({result.sources.length})
          </summary>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {result.sources.slice(0, 30).map((s, i) => (
              <li key={i} style={{ wordBreak: "break-all" }}>
                <code>{s}</code>
              </li>
            ))}
            {result.sources.length > 30 && (
              <li style={{ color: "var(--text-muted)" }}>
                ...and {result.sources.length - 30} more in sources.json
              </li>
            )}
          </ul>
        </details>
      )}
    </div>
  );
}

function CompetitorResultCard(props: {
  result: CompetitorScanResult;
  onOpenPath: (p: string) => void;
}) {
  const { result, onOpenPath } = props;
  return (
    <div
      style={{
        marginLeft: 64,
        padding: 10,
        background: "var(--bg-panel)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
        Scanned {result.competitor_count}, captured {result.pricing_rows_total} pricing row(s).
      </div>
      <button
        type="button"
        onClick={() => onOpenPath(result.pricing_csv)}
        style={openButtonStyle}
      >
        Open competitors-pricing.csv
      </button>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {result.competitors.map((c) => (
          <CompetitorRow key={c.slug} c={c} />
        ))}
      </div>
    </div>
  );
}

function CompetitorRow(props: { c: CompetitorBreakdown }) {
  const { c } = props;
  const flagsOk: string[] = [];
  if (c.wrote_landing) flagsOk.push("landing");
  if (c.wrote_pricing) flagsOk.push("pricing");
  if (c.wrote_about) flagsOk.push("about");
  return (
    <div
      style={{
        fontSize: 12,
        padding: "4px 0",
        borderTop: "1px solid var(--border-subtle)",
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <code style={{ minWidth: 140, color: "var(--text-primary)" }}>{c.slug}</code>
        <span style={{ color: "var(--text-tertiary)" }}>
          {c.pricing_rows} row(s)
        </span>
        <span style={{ color: "var(--text-muted)" }}>
          [{flagsOk.join(", ") || "no pages captured"}]
        </span>
      </div>
      {c.errors.length > 0 && (
        <ul style={{ margin: "2px 0 0 18px", color: "var(--danger, #f87171)", fontSize: 11 }}>
          {c.errors.map((e, i) => (
            <li key={i} style={{ wordBreak: "break-word" }}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function JobsListCard(props: { jobs: JobRecord[] }) {
  const { jobs } = props;
  if (jobs.length === 0) return null;
  return (
    <div
      style={{
        marginLeft: 64,
        padding: 10,
        background: "var(--bg-panel)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontSize: 12,
      }}
    >
      {jobs.map((j) => (
        <div key={j.job_id} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
          <code style={{ minWidth: 86, color: "var(--text-tertiary)" }}>
            {j.job_id.slice(0, 8)}
          </code>
          <span
            style={{
              minWidth: 70,
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              color: STATUS_COLOR[j.status],
            }}
          >
            {j.status}
          </span>
          <code style={{ minWidth: 110, color: "var(--text-secondary)" }}>{j.kind}</code>
          <span style={{ color: "var(--text-tertiary)", flex: 1 }}>
            slug={j.venture_slug}; {j.progress_message || "(no message)"}
          </span>
        </div>
      ))}
    </div>
  );
}

function IcpResultCard(props: {
  result: IcpResult;
  onOpenPath: (p: string) => void;
}) {
  const { result, onOpenPath } = props;
  return (
    <div
      style={{
        marginLeft: 64,
        padding: 10,
        background: "var(--bg-panel)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
        {result.personas_count} persona(s); summary {result.summary_chars.toLocaleString()} chars; from
        <code> {result.input_count}</code> input artifact(s).
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => onOpenPath(result.yaml_path)}
          style={openButtonStyle}
        >
          Open icp.yaml
        </button>
        <button
          type="button"
          onClick={() => onOpenPath(result.md_path)}
          style={openButtonStyle}
        >
          Open icp.md
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {result.personas.map((p: IcpPersonaSummary) => (
          <div
            key={p.id}
            style={{
              fontSize: 12,
              padding: "4px 0",
              borderTop: "1px solid var(--border-subtle)",
              display: "flex",
              gap: 8,
              alignItems: "baseline",
            }}
          >
            <code style={{ minWidth: 160, color: "var(--text-primary)" }}>{p.id}</code>
            <span style={{ color: "var(--text-secondary)", fontWeight: 600 }}>{p.name}</span>
            <span style={{ color: "var(--text-tertiary)", flex: 1 }}>{p.primaryGoal}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const openButtonStyle: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 12,
  border: "1px solid var(--border-subtle)",
  borderRadius: 4,
  background: "var(--bg-elevated)",
  color: "var(--text-primary)",
  cursor: "pointer",
};
