/**
 * ChatGPT `conversations.json` parser.
 *
 * The export is an array of conversations, each with a `mapping` tree
 * of message nodes keyed by node id. The tree is a linked-list-style
 * structure with parent / children pointers; the "leaf" is determined
 * by the `current_node` field. We walk parent links from current_node
 * up to the root, then reverse to get the chronological turn list.
 *
 * Per spec: "a malformed conversation in a 10-conversation export
 * doesn't fail the other 9" -- we wrap each conversation in a
 * try/catch and surface failures as warnings.
 */

import {
  type ChatConversation,
  type ChatRole,
  type ChatTurn,
  ChatImporterError,
  type ParsedChat,
} from "./types";

export function parseChatGptExport(rawJson: string): ParsedChat {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (cause) {
    throw new ChatImporterError("ChatGPT export is not valid JSON", cause);
  }
  if (!Array.isArray(parsed)) {
    throw new ChatImporterError(
      "ChatGPT export must be a JSON array of conversations",
    );
  }
  const conversations: ChatConversation[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    const raw = parsed[i];
    try {
      const convo = parseOneConversation(raw, i);
      if (convo) conversations.push(convo);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      warnings.push(`conversation #${i} skipped: ${message}`);
    }
  }
  return {
    extractionMethod: "chat_chatgpt",
    conversations,
    warnings,
  };
}

interface RawNode {
  id?: string;
  parent?: string | null;
  message?: {
    id?: string;
    author?: { role?: string };
    content?: { content_type?: string; parts?: unknown[] };
    create_time?: number;
  };
}

interface RawConversation {
  id?: string;
  title?: string;
  create_time?: number;
  update_time?: number;
  current_node?: string;
  mapping?: Record<string, RawNode>;
}

function parseOneConversation(raw: unknown, index: number): ChatConversation | null {
  if (!raw || typeof raw !== "object") {
    throw new Error("not an object");
  }
  const c = raw as RawConversation;
  if (!c.mapping || typeof c.mapping !== "object") {
    throw new Error("missing mapping");
  }

  const turns: ChatTurn[] = [];
  const startId = c.current_node;
  const walk: string[] = [];
  if (startId && c.mapping[startId]) {
    let cursor: string | null | undefined = startId;
    const guard = new Set<string>();
    while (cursor && c.mapping[cursor] && !guard.has(cursor)) {
      guard.add(cursor);
      walk.push(cursor);
      cursor = c.mapping[cursor]?.parent ?? null;
    }
    walk.reverse();
  } else {
    // Fall back: iterate the mapping in insertion order. ChatGPT
    // exports we've seen do preserve order; if they didn't, the
    // walk above would still be the right answer when current_node
    // points to a real leaf.
    for (const key of Object.keys(c.mapping)) walk.push(key);
  }

  for (const id of walk) {
    const node = c.mapping[id];
    if (!node?.message) continue;
    const role = mapRole(node.message.author?.role);
    const text = joinParts(node.message.content?.parts);
    if (!text.trim()) continue;
    turns.push({
      role,
      content: text.trim(),
      createdAt: node.message.create_time ? toIso(node.message.create_time) : undefined,
    });
  }

  if (turns.length === 0) return null;

  return {
    id: c.id ?? `chatgpt-${index}`,
    title: c.title?.trim() || `Untitled conversation ${index + 1}`,
    turns,
    createdAt: c.create_time ? toIso(c.create_time) : undefined,
    updatedAt: c.update_time ? toIso(c.update_time) : undefined,
  };
}

function mapRole(role: string | undefined): ChatRole {
  switch (role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "system":
      return "system";
    case "tool":
    case "function":
      return "tool";
    default:
      return "other";
  }
}

function joinParts(parts: unknown[] | undefined): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) => {
      if (typeof p === "string") return p;
      if (p && typeof p === "object" && "text" in p) {
        const v = (p as { text: unknown }).text;
        return typeof v === "string" ? v : "";
      }
      return "";
    })
    .join("\n")
    .trim();
}

function toIso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}
