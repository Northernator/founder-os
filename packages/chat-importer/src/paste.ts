/**
 * Pasted text. If the text smells like a chat transcript we route
 * through the generic parser; otherwise we emit a single-turn
 * conversation with role=other so the rest of the pipeline can treat
 * it like any other source.
 */

import { looksLikeChatTranscript, parseGenericTranscript } from "./generic";
import type { ParsedChat } from "./types";

export interface ParsePastedInput {
  text: string;
  /** Optional title -- falls back to the first non-empty line or "Pasted note". */
  title?: string;
}

export function parsePastedText(input: ParsePastedInput): ParsedChat {
  const text = input.text.trim();
  if (!text) {
    return {
      extractionMethod: "paste_text",
      conversations: [],
      warnings: ["pasted text was empty"],
    };
  }
  if (looksLikeChatTranscript(text)) {
    const parsed = parseGenericTranscript({
      text,
      defaultTitle: input.title,
      conversationId: "paste-0",
    });
    return {
      ...parsed,
      extractionMethod: "paste_text",
    };
  }
  const title = input.title || firstLineSummary(text) || "Pasted note";
  return {
    extractionMethod: "paste_text",
    conversations: [
      {
        id: "paste-0",
        title,
        turns: [{ role: "other", content: text }],
      },
    ],
    warnings: [],
  };
}

function firstLineSummary(text: string): string | undefined {
  const line = text.split(/\r?\n/).find((l) => l.trim());
  if (!line) return undefined;
  const trimmed = line.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}
