/**
 * Generic markdown transcript heuristic. Detects `^(User|Human|Assistant|
 * Claude|ChatGPT|System):` line prefixes (optionally surrounded by
 * markdown bold). Anything that doesn't open with one of those becomes
 * either the first turn (defaulting to `other`) or a title when it
 * starts with `# `.
 */

import {
  type ChatConversation,
  type ChatRole,
  type ChatTurn,
  type ParsedChat,
} from "./types";

const TURN_RE =
  /^\s*(?:\*\*)?(User|Human|Assistant|Claude|ChatGPT|System|Tool|Function)(?:\*\*)?\s*:\s*(.*)$/i;

export interface ParseGenericInput {
  text: string;
  /** Optional title override; otherwise derived from a leading `# ` line. */
  defaultTitle?: string;
  /** Lets callers tag the resulting conversation id deterministically. */
  conversationId?: string;
}

export function parseGenericTranscript(input: ParseGenericInput): ParsedChat {
  const text = input.text.replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  let title = input.defaultTitle ?? "Imported conversation";
  let cursor = 0;
  if (lines[0]?.startsWith("# ")) {
    const candidate = (lines[0] ?? "").slice(2).trim();
    if (candidate) title = candidate;
    cursor = 1;
  }

  const turns: ChatTurn[] = [];
  let currentRole: ChatRole | null = null;
  let bufLines: string[] = [];
  let sawAnyRoleMarker = false;
  const flush = () => {
    if (!currentRole && bufLines.every((l) => !l.trim())) {
      bufLines = [];
      return;
    }
    const text = bufLines.join("\n").trim();
    if (text) {
      turns.push({ role: currentRole ?? "other", content: text });
    }
    bufLines = [];
  };

  for (; cursor < lines.length; cursor += 1) {
    const line = lines[cursor] ?? "";
    const m = line.match(TURN_RE);
    if (m) {
      sawAnyRoleMarker = true;
      flush();
      currentRole = mapRole(m[1]);
      const trailing = m[2]?.trim();
      if (trailing) bufLines.push(trailing);
      continue;
    }
    bufLines.push(line);
  }
  flush();

  const warnings: string[] = [];
  if (!sawAnyRoleMarker) {
    warnings.push("no recognisable chat turns -- treating as a single other-role block");
  }

  const convo: ChatConversation = {
    id: input.conversationId ?? "generic-0",
    title,
    turns:
      turns.length > 0
        ? turns
        : [{ role: "other", content: text.trim() }],
  };

  return {
    extractionMethod: "chat_generic_markdown",
    conversations: [convo],
    warnings,
  };
}

export function looksLikeChatTranscript(text: string): boolean {
  const lines = text.split(/\r?\n/).slice(0, 50);
  let hits = 0;
  for (const line of lines) {
    if (TURN_RE.test(line)) hits += 1;
    if (hits >= 2) return true;
  }
  return false;
}

function mapRole(token: string | undefined): ChatRole {
  switch ((token ?? "").toLowerCase()) {
    case "user":
    case "human":
      return "user";
    case "assistant":
    case "claude":
    case "chatgpt":
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
