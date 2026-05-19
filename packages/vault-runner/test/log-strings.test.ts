/**
 * Drift-protected log strings for the Dream Vault runner.
 *
 * The desktop adoption helper (slice 9's run-vault-import.ts) will
 * parse `result.logs[].message` to derive per-step status for the
 * progress UI. If the runner silently changes a log string, the
 * helper downgrades gracefully (toast counts go to zero) without any
 * compile-time signal. This file is the safety net.
 */
import { describe, expect, it } from "vitest";
import { VAULT_LOG_STRINGS } from "../src/log-strings";
import { VaultStageRunner } from "../src/runner";
import type {
  ChatExtractorPort,
  DocumentExtractorPort,
  ImageExtractorPort,
} from "../src/types";
import {
  NOW,
  makeJob,
  makeLogger,
  makeResolveCachedPath,
  makeSource,
  makeStore,
  memoryVaultFs,
} from "./_helpers/fixtures";

const extractDocument: DocumentExtractorPort = async ({ doc }) => ({
  markdown: `# ${doc.originalName}\n\nbody\n`,
  summary: "summary",
  warnings: [],
  confidence: "medium",
  extractionMethod: "markdown_native",
  needsReview: false,
});
const extractImage: ImageExtractorPort = async () => ({
  pixelFormat: "png",
  width: 1, height: 1,
  warnings: [],
  confidence: "low",
  extractionMethod: "image_vision",
  needsReview: true,
});
const extractChat: ChatExtractorPort = async ({ doc }) => ({
  extractionMethod: "chat_chatgpt",
  conversations: [
    { id: "c1", title: doc.originalName, turns: [{ role: "user", content: "hi" }] },
  ],
  warnings: [],
});

function messages(logs: { message: string }[]): string[] {
  return logs.map((l) => l.message);
}

describe("VaultStageRunner emits all 9 phase log strings on full success", () => {
  it("phases 1-9 each fire exactly the literal string the helper will pattern-match", async () => {
    const runner = new VaultStageRunner({
      job: makeJob({ fileCount: 3 }),
      sources: [
        makeSource({ id: "src-doc", originalName: "a.md", sourceType: "document" }),
        makeSource({ id: "src-img", originalName: "b.png", sourceType: "image" }),
        makeSource({ id: "src-chat", originalName: "c.json", sourceType: "chat" }),
      ],
      workspaceRoot: "/ws",
      resolveCachedPath: makeResolveCachedPath("/ws"),
      candidates: [],
      extractDocument,
      extractImage,
      extractChat,
      vaultFs: memoryVaultFs(),
      logger: makeLogger(),
      nowFn: () => NOW,
    });
    const result = await runner.run();
    const msgs = messages(result.logs);

    expect(msgs).toContain(VAULT_LOG_STRINGS.starting);
    expect(msgs).toContain(VAULT_LOG_STRINGS.copying);
    expect(msgs).toContain(VAULT_LOG_STRINGS.detecting);
    expect(msgs).toContain(VAULT_LOG_STRINGS.extractingText);
    expect(msgs).toContain(VAULT_LOG_STRINGS.analysingImages);
    expect(msgs).toContain(VAULT_LOG_STRINGS.parsingChats);
    expect(msgs).toContain(VAULT_LOG_STRINGS.classifying);
    expect(msgs).toContain(VAULT_LOG_STRINGS.extractingKnowledge);
    expect(msgs).toContain(VAULT_LOG_STRINGS.generatingDrafts);
    expect(msgs).toContain(VAULT_LOG_STRINGS.readyForReview);
  });

  it("finalize() emits the 3 commit-path log strings", async () => {
    const job = makeJob({ fileCount: 1 });
    const store = makeStore(job);
    const runner = new VaultStageRunner({
      job,
      sources: [makeSource({ id: "src-doc", originalName: "a.md", sourceType: "document" })],
      workspaceRoot: "/ws",
      resolveCachedPath: makeResolveCachedPath("/ws"),
      candidates: [],
      extractDocument,
      extractImage,
      extractChat,
      vaultFs: memoryVaultFs(),
      store,
      logger: makeLogger(),
      nowFn: () => NOW,
    });
    await runner.run();
    const finalize = await runner.finalize({
      approvals: [{ sourceDocumentId: "src-doc", ventureSlug: null }],
      now: NOW,
    });
    const msgs = messages(finalize.logs);
    expect(msgs).toContain(VAULT_LOG_STRINGS.finalising);
    expect(msgs).toContain(VAULT_LOG_STRINGS.notesWritten);
    expect(msgs).toContain(VAULT_LOG_STRINGS.committed);
  });

  it("emits Vault source failed when an extractor throws", async () => {
    const throwingDoc: DocumentExtractorPort = async () => {
      throw new Error("boom");
    };
    const runner = new VaultStageRunner({
      job: makeJob({ fileCount: 1 }),
      sources: [makeSource({ id: "src-bad", originalName: "x.md", sourceType: "document" })],
      workspaceRoot: "/ws",
      resolveCachedPath: makeResolveCachedPath("/ws"),
      candidates: [],
      extractDocument: throwingDoc,
      extractImage,
      extractChat,
      vaultFs: memoryVaultFs(),
      logger: makeLogger(),
      nowFn: () => NOW,
    });
    const result = await runner.run();
    expect(messages(result.logs)).toContain(VAULT_LOG_STRINGS.sourceFailed);
  });

  it("log-string registry has stable keys (drift-protection)", () => {
    expect(VAULT_LOG_STRINGS.starting).toBe("Vault import starting");
    expect(VAULT_LOG_STRINGS.copying).toBe("Copying files to import cache");
    expect(VAULT_LOG_STRINGS.detecting).toBe("Detecting file types");
    expect(VAULT_LOG_STRINGS.extractingText).toBe("Extracting text");
    expect(VAULT_LOG_STRINGS.analysingImages).toBe("Analysing images");
    expect(VAULT_LOG_STRINGS.parsingChats).toBe("Parsing chats");
    expect(VAULT_LOG_STRINGS.classifying).toBe("Classifying projects");
    expect(VAULT_LOG_STRINGS.extractingKnowledge).toBe("Extracting knowledge");
    expect(VAULT_LOG_STRINGS.generatingDrafts).toBe("Generating draft vault notes");
    expect(VAULT_LOG_STRINGS.readyForReview).toBe("Ready for review");
    expect(VAULT_LOG_STRINGS.finalising).toBe("Vault import finalising");
    expect(VAULT_LOG_STRINGS.notesWritten).toBe("Vault notes written");
    expect(VAULT_LOG_STRINGS.committed).toBe("Vault import committed");
  });
});
