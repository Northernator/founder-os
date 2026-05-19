/**
 * Slice 8 -- extract stage. Walks each SourceDocument through the
 * appropriate extractor port (document / image / chat) based on its
 * sourceType, catches per-source failures so a single bad file does
 * not sink the rest of the job.
 */
import { renderConversationToMarkdown } from "@founder-os/chat-importer";
import type { SourceDocument } from "@founder-os/vault-contract";
import type {
  ChatExtractorPort,
  DocumentExtractorPort,
  ImageExtractorPort,
  VaultRunnerOpts,
  VaultSourceProcessing,
} from "./types.js";

type DispatchInput = {
  doc: SourceDocument;
  workspaceRoot: string;
  resolveCachedPath: (workspaceRelativePath: string) => string;
  extractDocument: DocumentExtractorPort;
  extractImage: ImageExtractorPort;
  extractChat: ChatExtractorPort;
  ocrEngine?: VaultRunnerOpts["ocrEngine"];
  visionCallLlm?: VaultRunnerOpts["visionCallLlm"];
};

/**
 * Render a chat ParsedChat into a single markdown blob the classifier
 * + knowledge-extractor prompt with. Concatenates every conversation
 * the parser found; the per-conversation render keeps role + timestamp
 * labels so the LLM has them.
 */
function chatToMarkdown(input: { conversations: ReturnType<typeof renderConversationToMarkdown>[] }): string {
  return input.conversations.join("\n\n---\n\n");
}

export async function dispatchExtraction(
  input: DispatchInput
): Promise<VaultSourceProcessing> {
  const { doc } = input;
  const cachedAbsolutePath = input.resolveCachedPath(doc.cachedOriginalPath);
  const portInput = {
    doc,
    cachedAbsolutePath,
    workspaceRoot: input.workspaceRoot,
  };
  try {
    switch (doc.sourceType) {
      case "image": {
        const result = await input.extractImage({
          ...portInput,
          ...(input.ocrEngine ? { ocrEngine: input.ocrEngine } : {}),
          ...(input.visionCallLlm ? { visionCallLlm: input.visionCallLlm } : {}),
        });
        const summaryParts: string[] = [];
        if (result.visionSummary) summaryParts.push(result.visionSummary);
        else if (result.ocrText) summaryParts.push(`OCR text: ${result.ocrText.slice(0, 300)}`);
        const markdown = [
          result.visionSummary ? `## Vision summary\n\n${result.visionSummary}` : "",
          result.ocrText ? `## OCR text\n\n\`\`\`\n${result.ocrText}\n\`\`\`` : "",
        ]
          .filter((s) => s.length > 0)
          .join("\n\n");
        return {
          source: doc,
          markdown,
          ...(summaryParts.length > 0 ? { summary: summaryParts.join(" / ") } : {}),
          extraction: { kind: "image", result },
          drafts: [],
        };
      }
      case "chat":
      case "transcript": {
        const result = await input.extractChat(portInput);
        const conversationMarkdowns = result.conversations.map(renderConversationToMarkdown);
        const markdown = chatToMarkdown({ conversations: conversationMarkdowns });
        const summaryPieces = result.conversations.map(
          (c) => `${c.title} (${c.turns.length} turns)`
        );
        return {
          source: doc,
          markdown,
          ...(summaryPieces.length > 0 ? { summary: summaryPieces.join("; ") } : {}),
          extraction: { kind: "chat", result },
          drafts: [],
        };
      }
      default: {
        const result = await input.extractDocument(portInput);
        return {
          source: doc,
          markdown: result.markdown,
          ...(result.summary ? { summary: result.summary } : {}),
          extraction: { kind: "document", result },
          drafts: [],
        };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      source: doc,
      markdown: "",
      extraction: { kind: "failed", error: message },
      drafts: [],
    };
  }
}

/** Counts the runner threads into log payloads after the extract phase. */
export function summariseExtractionCounts(
  perSource: VaultSourceProcessing[]
): {
  documents: number;
  images: number;
  chats: number;
  failed: number;
  skipped: number;
} {
  let documents = 0;
  let images = 0;
  let chats = 0;
  let failed = 0;
  let skipped = 0;
  for (const p of perSource) {
    switch (p.extraction.kind) {
      case "document":
        documents += 1;
        break;
      case "image":
        images += 1;
        break;
      case "chat":
        chats += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "skipped":
        skipped += 1;
        break;
    }
  }
  return { documents, images, chats, failed, skipped };
}
