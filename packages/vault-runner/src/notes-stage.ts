/**
 * Slice 8 -- notes stage. Produces VaultNoteDraft rows the human
 * reviewer sees on the review screen. Drafts are held in memory; the
 * runner's `finalize()` is what actually writes them to disk via the
 * markdown-vault fs port.
 *
 * Per source, the runner builds:
 *   - one primary note matching the source type
 *     (chat_summary, document_summary, image_note, raw_archive)
 *   - one decision_log / task_list / prompt_pack / research_note /
 *     brand_reference / ui_reference note when the knowledge extractor
 *     surfaced 1+ items of that kind for the source.
 *
 * The variables passed to the template renderer mirror the
 * documented template contracts in @founder-os/markdown-vault.
 */
import { renderVaultNoteContent } from "@founder-os/markdown-vault";
import type {
  ExtractedItem,
  SourceDocument,
  VaultNoteType,
} from "@founder-os/vault-contract";
import { pickBestVentureSlug } from "./classify-stage.js";
import type {
  VaultNoteDraft,
  VaultRunnerOpts,
  VaultSourceProcessing,
} from "./types.js";

/** Stable per-source per-template note id. */
export function buildDraftId(sourceDocumentId: string, noteType: VaultNoteType): string {
  return `${sourceDocumentId}/${noteType}`;
}

function primaryNoteType(doc: SourceDocument): VaultNoteType {
  switch (doc.sourceType) {
    case "chat":
    case "transcript":
      return "chat_summary";
    case "image":
      return "image_note";
    default:
      return "document_summary";
  }
}

function primaryVariables(p: VaultSourceProcessing): Record<string, unknown> {
  const doc = p.source;
  switch (primaryNoteType(doc)) {
    case "chat_summary": {
      const chat = p.extraction.kind === "chat" ? p.extraction.result : null;
      const turnCount = chat?.conversations.reduce((acc, c) => acc + c.turns.length, 0) ?? 0;
      const provider = chat
        ? chat.extractionMethod.startsWith("chat_claude")
          ? "Claude"
          : chat.extractionMethod === "chat_chatgpt"
            ? "ChatGPT"
            : chat.extractionMethod === "chat_generic_markdown"
              ? "Generic"
              : "Paste"
        : "Unknown";
      const keyDecisions = (p.knowledge?.items ?? [])
        .filter((i) => i.type === "decision")
        .slice(0, 10)
        .map((i) => ({ title: i.title, content: i.content }));
      const keyTasks = (p.knowledge?.items ?? [])
        .filter((i) => i.type === "task" || i.type === "todo")
        .slice(0, 10)
        .map((i) => ({ title: i.title, content: i.content }));
      return {
        chatTitle: doc.originalName,
        chatProvider: provider,
        ...(chat?.conversations[0]?.createdAt
          ? { chatDate: chat.conversations[0].createdAt }
          : {}),
        turnCount,
        summary: p.summary ?? "(no summary extracted)",
        keyDecisions,
        keyTasks,
        transcript: p.markdown,
      };
    }
    case "image_note": {
      const img = p.extraction.kind === "image" ? p.extraction.result : null;
      return {
        imageTitle: doc.originalName,
        ...(img?.width ? { width: img.width } : {}),
        ...(img?.height ? { height: img.height } : {}),
        ...(img?.ocrText ? { ocrText: img.ocrText } : {}),
        ...(img?.visionSummary ? { visionSummary: img.visionSummary } : {}),
        tags: [],
      };
    }
    default: {
      const facts = (p.knowledge?.items ?? [])
        .filter((i) => i.type === "fact" || i.type === "research_finding")
        .slice(0, 10)
        .map((i) => ({ title: i.title, content: i.content }));
      return {
        docTitle: doc.originalName,
        ...(doc.mimeType ? { docMime: doc.mimeType } : {}),
        docOriginalName: doc.originalName,
        summary: p.summary ?? "(no summary extracted)",
        keyFacts: facts,
        ...(p.markdown ? { markdown: p.markdown } : {}),
      };
    }
  }
}

type SecondaryRule = {
  noteType: VaultNoteType;
  matches: (item: ExtractedItem) => boolean;
  build: (items: ExtractedItem[], doc: SourceDocument) => Record<string, unknown>;
};

const SECONDARY_RULES: SecondaryRule[] = [
  {
    noteType: "decision_log",
    matches: (i) => i.type === "decision",
    build: (items, doc) => {
      const first = items[0];
      return {
        entryTitle: first?.title ?? `${doc.originalName} -- decisions`,
        decisionMade: first?.content ?? "(no content extracted)",
        ...(items.length > 1
          ? {
              relatedItems: items.slice(1, 10).map((i) => ({ title: i.title, content: i.content })),
            }
          : {}),
      };
    },
  },
  {
    noteType: "task_list",
    matches: (i) => i.type === "task" || i.type === "todo",
    build: (items, doc) => ({
      listTitle: `${doc.originalName} -- tasks`,
      tasks: items.slice(0, 20).map((i) => ({
        title: i.title,
        content: i.content,
        status: " ",
      })),
    }),
  },
  {
    noteType: "prompt_pack",
    matches: (i) => i.type === "prompt",
    build: (items, doc) => ({
      packTitle: `${doc.originalName} -- prompts`,
      prompts: items.slice(0, 20).map((i) => ({ title: i.title, content: i.content })),
    }),
  },
  {
    noteType: "research_note",
    matches: (i) => i.type === "research_finding" || i.type === "fact",
    build: (items, doc) => ({
      noteTitle: `${doc.originalName} -- research`,
      findings: items.slice(0, 20).map((i) => ({ title: i.title, content: i.content })),
    }),
  },
  {
    noteType: "brand_reference",
    matches: (i) => i.type === "brand_reference",
    build: (items, doc) => ({
      refTitle: `${doc.originalName} -- brand`,
      descriptions: items.slice(0, 20).map((i) => `**${i.title}** -- ${i.content}`),
    }),
  },
  {
    noteType: "ui_reference",
    matches: (i) => i.type === "ui_reference",
    build: (items, doc) => ({
      refTitle: `${doc.originalName} -- ui`,
      components: items.slice(0, 20).map((i) => `${i.title}: ${i.content}`),
    }),
  },
];

function buildDraft(input: {
  source: SourceDocument;
  noteType: VaultNoteType;
  title: string;
  suggestedSlug: string | null;
  variables: Record<string, unknown>;
  itemIds: string[];
  tags: string[];
  workspaceRoot: string;
  now: string;
}): VaultNoteDraft {
  const rendered = renderVaultNoteContent({
    workspaceRoot: input.workspaceRoot,
    ventureSlug: input.suggestedSlug,
    noteType: input.noteType,
    noteId: buildDraftId(input.source.id, input.noteType),
    title: input.title,
    sourceDocumentId: input.source.id,
    itemIds: input.itemIds,
    tags: input.tags,
    ...(input.source.confidence ? { confidence: input.source.confidence } : {}),
    now: input.now,
    variables: input.variables,
  });
  return {
    noteId: buildDraftId(input.source.id, input.noteType),
    noteType: input.noteType,
    sourceDocumentId: input.source.id,
    suggestedVentureSlug: input.suggestedSlug,
    title: input.title,
    previewContent: rendered.content,
    previewFrontmatter: rendered.frontmatter,
    itemIds: input.itemIds,
    tags: input.tags,
    ...(input.source.confidence ? { confidence: input.source.confidence } : {}),
    variables: input.variables,
  };
}

export function buildDraftsForSource(input: {
  source: VaultSourceProcessing;
  items: ExtractedItem[];
  candidates: VaultRunnerOpts["candidates"];
  workspaceRoot: string;
  now: string;
}): VaultNoteDraft[] {
  const drafts: VaultNoteDraft[] = [];
  const suggestedSlug = pickBestVentureSlug(
    input.source.classification?.matches ?? [],
    input.candidates
  );

  // Primary note (one per source).
  const primaryType = primaryNoteType(input.source.source);
  drafts.push(
    buildDraft({
      source: input.source.source,
      noteType: primaryType,
      title: input.source.source.originalName,
      suggestedSlug,
      variables: primaryVariables(input.source),
      itemIds: input.items.map((i) => i.id),
      tags: [],
      workspaceRoot: input.workspaceRoot,
      now: input.now,
    })
  );

  // Secondary notes: one per rule that has matching items.
  for (const rule of SECONDARY_RULES) {
    const matching = input.items.filter(rule.matches);
    if (matching.length === 0) continue;
    drafts.push(
      buildDraft({
        source: input.source.source,
        noteType: rule.noteType,
        title: `${input.source.source.originalName} -- ${rule.noteType.replace(/_/g, " ")}`,
        suggestedSlug,
        variables: rule.build(matching, input.source.source),
        itemIds: matching.map((i) => i.id),
        tags: [],
        workspaceRoot: input.workspaceRoot,
        now: input.now,
      })
    );
  }

  input.source.drafts = drafts;
  return drafts;
}
