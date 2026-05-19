/**
 * Render a parsed conversation to markdown. The chat-summary template
 * (slice 7) consumes this string directly.
 */

import type { ChatConversation } from "./types";

export function renderConversationToMarkdown(convo: ChatConversation): string {
  const lines: string[] = [`# ${convo.title}`, ""];
  for (const turn of convo.turns) {
    const label = roleLabel(turn.role);
    if (turn.createdAt) {
      lines.push(`**${label}** _(${turn.createdAt})_`);
    } else {
      lines.push(`**${label}**`);
    }
    lines.push("");
    lines.push(turn.content);
    lines.push("");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function roleLabel(role: ChatConversation["turns"][number]["role"]): string {
  switch (role) {
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
    case "system":
      return "System";
    case "tool":
      return "Tool";
    default:
      return "Other";
  }
}
