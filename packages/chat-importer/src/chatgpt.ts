/**
 * ChatGPT `conversations.json` parser.
 *
 * Two input shapes are supported:
 *
 *   1. The canonical full-export shape: a JSON array where every
 *      element is one conversation. This is what ChatGPT's
 *      "Export data" feature produces in `conversations.json`.
 *
 *   2. A single conversation as a top-level object: `{ mapping,
 *      current_node, title, ... }`. This is the shape of the
 *      per-conversation UUID-named files some users keep -- e.g.
 *      tooling that splits the canonical export by conversation,
 *      or hand-saved single-conversation extracts. Before this
 *      branch was added, those files hit the runner's fallback
 *      chain (chatgpt -> claude -> paste) and produced empty
 *      output because none of the parsers handled the shape.
 *
 * Each conversation has a `mapping` tree of message nodes keyed by
 * node id. The tree is a linked-list-style structure with parent /
 * children pointers; the "leaf" is determined by the `current_node`
 * field. We walk parent links from current_node up to the root, then
 * reverse to get the chronological turn list.
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

/**
 * Discriminator for the single-conversation shape. Requires `mapping`
 * to be a non-null object (the tree itself); `current_node` is
 * preferred but not required since the parser has an
 * insertion-order fallback when it's missing.
 */
function isSingleConversationObject(value: unknown): value is { mapping: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.mapping !== null && typeof v.mapping === "object";
}

export function parseChatGptExport(rawJson: string): ParsedChat {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (cause) {
    throw new ChatImporterError("ChatGPT export is not valid JSON", cause);
  }

  // Normalise to an array. Per-conversation UUID-named files arrive
  // as a single object with `mapping` at the top level -- wrap so
  // the per-conversation loop below works uniformly for both shapes.
  let conversationsRaw: unknown[];
  if (Array.isArray(parsed)) {
    conversationsRaw = parsed;
  } else if (isSingleConversationObject(parsed)) {
    conversationsRaw = [parsed];
  } else {
    throw new ChatImporterError(
      "ChatGPT export must be a JSON array of conversations or a single conversation object with a `mapping` property",
    );
  }

  const conversations: ChatConversation[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < conversationsRaw.length; i += 1) {
    const raw = conversationsRaw[i];
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
