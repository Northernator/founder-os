/**
 * Claude export parser. Handles both the JSON shape (an array of
 * conversation objects with `chat_messages: [{ sender, text, created_at }]`)
 * and the markdown shape (one or more conversations separated by `---`
 * with `**Human:**` / `**Assistant:**` labels).
 */

import {
  type ChatConversation,
  type ChatRole,
  type ChatTurn,
  ChatImporterError,
  type ParsedChat,
} from "./types";

export function parseClaudeJsonExport(rawJson: string): ParsedChat {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (cause) {
    throw new ChatImporterError("Claude JSON export is not valid JSON", cause);
  }
  // Accept both `[{...}]` and `{ conversations: [...] }` shapes.
  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { conversations?: unknown }).conversations)
      ? ((parsed as { conversations: unknown[] }).conversations)
      : [];
  const conversations: ChatConversation[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < list.length; i += 1) {
    try {
      const convo = parseOneClaudeJson(list[i], i);
      if (convo) conversations.push(convo);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      warnings.push(`conversation #${i} skipped: ${message}`);
    }
  }
  return {
    extractionMethod: "chat_claude",
    conversations,
    warnings,
  };
}

interface RawClaudeJsonConvo {
  uuid?: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
  chat_messages?: Array<{
    sender?: string;
    text?: string;
    content?: Array<{ type?: string; text?: string }>;
    created_at?: string;
  }>;
}

function parseOneClaudeJson(raw: unknown, index: number): ChatConversation | null {
  if (!raw || typeof raw !== "object") throw new Error("not an object");
  const c = raw as RawClaudeJsonConvo;
  if ("chat_messages" in c && c.chat_messages !== undefined && !Array.isArray(c.chat_messages)) {
    throw new Error("chat_messages is not an array");
  }
  const messages = Array.isArray(c.chat_messages) ? c.chat_messages : [];
  if (messages.length === 0) return null;
  const turns: ChatTurn[] = [];
  for (const m of messages) {
    const text = pickClaudeText(m);
    if (!text.trim()) continue;
    turns.push({
      role: mapClaudeRole(m.sender),
      content: text.trim(),
      createdAt: typeof m.created_at === "string" ? m.created_at : undefined,
    });
  }
  if (turns.length === 0) return null;
  return {
    id: c.uuid ?? `claude-${index}`,
    title: c.name?.trim() || `Untitled conversation ${index + 1}`,
    turns,
    createdAt: typeof c.created_at === "string" ? c.created_at : undefined,
    updatedAt: typeof c.updated_at === "string" ? c.updated_at : undefined,
  };
}

function pickClaudeText(m: {
  text?: string;
  content?: Array<{ type?: string; text?: string }>;
}): string {
  if (typeof m.text === "string" && m.text.trim()) return m.text;
  if (Array.isArray(m.content)) {
    return m.content
      .map((c) => (typeof c.text === "string" ? c.text : ""))
      .join("\n");
  }
  return "";
}

function mapClaudeRole(sender: string | undefined): ChatRole {
  switch ((sender ?? "").toLowerCase()) {
    case "human":
    case "user":
      return "user";
    case "assistant":
    case "claude":
      return "assistant";
    case "system":
      return "system";
    default:
      return "other";
  }
}

/**
 * Claude's markdown export uses `---` separators between conversations
 * and `**Human:**` / `**Assistant:**` for turn boundaries. The first
 * line of each block is conventionally `# Title`.
 */
export function parseClaudeMarkdownExport(raw: string): ParsedChat {
  const text = raw.replace(/\r\n/g, "\n");
  const blocks = text.split(/\n-{3,}\n/);
  const conversations: ChatConversation[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]?.trim();
    if (!block) continue;
    try {
      const convo = parseClaudeMarkdownBlock(block, i);
      if (convo) conversations.push(convo);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      warnings.push(`block #${i} skipped: ${message}`);
    }
  }
  return {
    extractionMethod: "chat_claude",
    conversations,
    warnings,
  };
}

const CLAUDE_TURN_RE = /^\s*\*\*(Human|Assistant|Claude|User|System)\*\*\s*:?\s*$/i;

function parseClaudeMarkdownBlock(block: string, index: number): ChatConversation | null {
  const lines = block.split("\n");
  let title = `Untitled conversation ${index + 1}`;
  let cursor = 0;
  if (lines[0]?.startsWith("# ")) {
    title = (lines[0] ?? "").slice(2).trim() || title;
    cursor = 1;
  }
  const turns: ChatTurn[] = [];
  let currentRole: ChatRole | null = null;
  let bufLines: string[] = [];
  const flush = () => {
    if (!currentRole) return;
    const text = bufLines.join("\n").trim();
    if (text) turns.push({ role: currentRole, content: text });
    bufLines = [];
  };
  for (; cursor < lines.length; cursor += 1) {
    const line = lines[cursor] ?? "";
    const m = line.match(CLAUDE_TURN_RE);
    if (m) {
      flush();
      currentRole = mapClaudeRole(m[1]);
      continue;
    }
    bufLines.push(line);
  }
  flush();
  if (turns.length === 0) return null;
  return { id: `claude-md-${index}`, title, turns };
}
