import { describe, expect, it } from "vitest";
import type {
  ChatExtractorPort,
  DocumentExtractorPort,
  ImageExtractorPort,
} from "../src/types";
import { VaultStageRunner } from "../src/runner";
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
  markdown: `# ${doc.originalName}\n\n- decided: ship May 30\n- TODO: brief the team\n`,
  summary: `Summary for ${doc.originalName}`,
  warnings: [],
  confidence: "medium",
  extractionMethod: "markdown_native",
  needsReview: false,
});

const extractImage: ImageExtractorPort = async ({ doc }) => ({
  pixelFormat: "png",
  width: 1440,
  height: 900,
  ocrText: `OCR for ${doc.originalName}`,
  visionSummary: "A nicely-composed hero shot.",
  warnings: [],
  confidence: "medium",
  extractionMethod: "image_vision",
  needsReview: false,
});

const extractChat: ChatExtractorPort = async ({ doc }) => ({
  extractionMethod: "chat_chatgpt",
  conversations: [
    {
      id: `${doc.id}/c1`,
      title: doc.originalName,
      turns: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ],
    },
  ],
  warnings: [],
});

describe("VaultStageRunner -- happy path", () => {
  it("runs phases 1-9 + returns drafts when LLM is wired", async () => {
    const job = makeJob({ fileCount: 3 });
    const sources = [
      makeSource({ id: "src-doc", originalName: "kickoff-notes.md", sourceType: "document" }),
      makeSource({ id: "src-img", originalName: "home-hero.png", sourceType: "image", mimeType: "image/png" }),
      makeSource({ id: "src-chat", originalName: "chatgpt-export.json", sourceType: "chat" }),
    ];

    let llmHit = 0;
    const callLlm = async () => {
      llmHit += 1;
      // Return alternating: empty JSON array for classifier, valid items for knowledge.
      // The classifier asks twice per source (when both calls happen), so just emit JSON arrays.
      if (llmHit % 2 === 1) {
        return JSON.stringify([
          { projectId: "v-dl", confidence: "high", reason: "matches title" },
        ]);
      }
      return JSON.stringify([
        { type: "decision", title: "Lock May 30", content: "Final.", confidence: "high" },
        { type: "task", title: "Brief PR", content: "Email Susan.", confidence: "medium" },
      ]);
    };

    const runner = new VaultStageRunner({
      job,
      sources,
      workspaceRoot: "/ws",
      resolveCachedPath: makeResolveCachedPath("/ws"),
      candidates: [
        { projectId: "v-dl", name: "DreamLauncher", slug: "dreamlauncher" },
      ],
      extractDocument,
      extractImage,
      extractChat,
      callLlm,
      vaultFs: memoryVaultFs(),
      logger: makeLogger(),
      nowFn: () => NOW,
    });

    const result = await runner.run();

    expect(result.status).toBe("needs_review");
    expect(result.jobId).toBe("job-1");
    expect(result.perSource).toHaveLength(3);
    expect(Object.keys(result.matches).sort()).toEqual([
      "src-chat",
      "src-doc",
      "src-img",
    ]);
    expect(result.drafts.length).toBeGreaterThanOrEqual(3);
    // Primary note per source must always be present:
    const primaryTypes = result.drafts.map((d) => d.noteType).sort();
    expect(primaryTypes).toEqual(expect.arrayContaining(["chat_summary", "document_summary", "image_note"]));
    // Suggested venture slug picked from the LLM's "high" confidence match:
    const docDraft = result.drafts.find((d) => d.sourceDocumentId === "src-doc");
    expect(docDraft?.suggestedVentureSlug).toBe("dreamlauncher");
  });

  it("works with no LLM wired (deterministic fallback path)", async () => {
    const job = makeJob({ fileCount: 1 });
    const sources = [
      makeSource({ id: "src-doc", originalName: "weekly-notes.md", sourceType: "document" }),
    ];
    const runner = new VaultStageRunner({
      job,
      sources,
      workspaceRoot: "/ws",
      resolveCachedPath: makeResolveCachedPath("/ws"),
      candidates: [
        { projectId: "v-dl", name: "DreamLauncher", slug: "dreamlauncher", summary: "AI startup studio" },
      ],
      extractDocument,
      extractImage,
      extractChat,
      vaultFs: memoryVaultFs(),
      logger: makeLogger(),
      nowFn: () => NOW,
    });
    const result = await runner.run();
    expect(result.status).toBe("needs_review");
    // No LLM means: classifier falls back to keyword overlap (unsorted/low),
    // knowledge falls back to heuristics (>=1 summary item).
    expect(result.matches["src-doc"]).toBeDefined();
    expect(result.items["src-doc"]?.length).toBeGreaterThan(0);
    expect(result.drafts.length).toBeGreaterThan(0);
  });

  it("isolates per-source failures so siblings still produce drafts", async () => {
    const job = makeJob({ fileCount: 2 });
    const sources = [
      makeSource({ id: "src-good", originalName: "good.md", sourceType: "document" }),
      makeSource({ id: "src-bad", originalName: "bad.md", sourceType: "document" }),
    ];
    const throwingExtractor: DocumentExtractorPort = async ({ doc }) => {
      if (doc.id === "src-bad") {
        throw new Error("simulated extraction crash");
      }
      return extractDocument({ doc, cachedAbsolutePath: "", workspaceRoot: "/ws" });
    };
    const runner = new VaultStageRunner({
      job,
      sources,
      workspaceRoot: "/ws",
      resolveCachedPath: makeResolveCachedPath("/ws"),
      candidates: [],
      extractDocument: throwingExtractor,
      extractImage,
      extractChat,
      vaultFs: memoryVaultFs(),
      logger: makeLogger(),
      nowFn: () => NOW,
    });
    const result = await runner.run();
    expect(result.status).toBe("needs_review");
    expect(result.perSource).toHaveLength(2);
    const bad = result.perSource.find((p) => p.source.id === "src-bad");
    expect(bad?.extraction.kind).toBe("failed");
    if (bad?.extraction.kind === "failed") {
      expect(bad.extraction.error).toMatch(/simulated extraction crash/);
    }
    // Sibling still produced drafts:
    const good = result.perSource.find((p) => p.source.id === "src-good");
    expect(good?.extraction.kind).toBe("document");
    expect(good?.drafts.length).toBeGreaterThan(0);
    // Aggregated warning surfaced for the UI:
    expect(result.warnings.join("\n")).toMatch(/src-bad.*extraction failed/);
  });

  it("validate() rejects an empty source list and a wrong job status", async () => {
    const runner = new VaultStageRunner({
      job: makeJob({ status: "committed" }),
      sources: [],
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
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("VAULT_VALIDATE_FAILED");
    expect(result.error?.message).toMatch(/needs_review/);
    expect(result.error?.message).toMatch(/staged source/);
  });
});

describe("VaultStageRunner -- finalize()", () => {
  it("writes approved notes via the fs port and flips job to committed", async () => {
    const job = makeJob({ fileCount: 1 });
    const sources = [
      makeSource({ id: "src-doc", originalName: "kickoff.md", sourceType: "document" }),
    ];
    const fs = memoryVaultFs();
    const store = makeStore(job);
    const runner = new VaultStageRunner({
      job,
      sources,
      workspaceRoot: "/ws",
      resolveCachedPath: makeResolveCachedPath("/ws"),
      candidates: [
        { projectId: "v-dl", name: "DreamLauncher", slug: "dreamlauncher" },
      ],
      extractDocument,
      extractImage,
      extractChat,
      vaultFs: fs,
      store,
      logger: makeLogger(),
      nowFn: () => NOW,
    });

    const runResult = await runner.run();
    expect(runResult.status).toBe("needs_review");
    expect(runResult.drafts.length).toBeGreaterThan(0);

    const finalizeResult = await runner.finalize({
      approvals: [
        { sourceDocumentId: "src-doc", ventureSlug: "dreamlauncher" },
      ],
      now: NOW,
    });

    expect(finalizeResult.status).toBe("committed");
    expect(finalizeResult.notesWritten.length).toBe(runResult.drafts.length);
    for (const w of finalizeResult.notesWritten) {
      expect(w.absolutePath).toContain("_vault/projects/dreamlauncher/");
      expect(fs.files.has(w.absolutePath)).toBe(true);
    }
    expect(store.lastStatus()).toBe("committed");
  });

  it("skips drafts when the source has no approval and counts them", async () => {
    const job = makeJob({ fileCount: 2 });
    const sources = [
      makeSource({ id: "src-a", originalName: "a.md", sourceType: "document" }),
      makeSource({ id: "src-b", originalName: "b.md", sourceType: "document" }),
    ];
    const fs = memoryVaultFs();
    const runner = new VaultStageRunner({
      job,
      sources,
      workspaceRoot: "/ws",
      resolveCachedPath: makeResolveCachedPath("/ws"),
      candidates: [],
      extractDocument,
      extractImage,
      extractChat,
      vaultFs: fs,
      logger: makeLogger(),
      nowFn: () => NOW,
    });
    const runResult = await runner.run();
    const aDrafts = runResult.drafts.filter((d) => d.sourceDocumentId === "src-a").length;
    const bDrafts = runResult.drafts.filter((d) => d.sourceDocumentId === "src-b").length;

    const finalize = await runner.finalize({
      approvals: [{ sourceDocumentId: "src-a", ventureSlug: null }],
      now: NOW,
    });

    expect(finalize.status).toBe("committed");
    expect(finalize.notesWritten.length).toBe(aDrafts);
    expect(finalize.skippedCount).toBe(bDrafts);
    // Unsorted route lands under _vault/unsorted/:
    for (const w of finalize.notesWritten) {
      expect(w.absolutePath).toMatch(/_vault\/unsorted\//);
    }
  });

  it("honours acceptedNoteIds to drop individual drafts", async () => {
    const job = makeJob({ fileCount: 1 });
    const sources = [
      makeSource({ id: "src-a", originalName: "a.md", sourceType: "document" }),
    ];
    const fs = memoryVaultFs();
    const runner = new VaultStageRunner({
      job,
      sources,
      workspaceRoot: "/ws",
      resolveCachedPath: makeResolveCachedPath("/ws"),
      candidates: [],
      extractDocument,
      extractImage,
      extractChat,
      vaultFs: fs,
      logger: makeLogger(),
      nowFn: () => NOW,
    });
    const runResult = await runner.run();
    const primaryDraft = runResult.drafts.find((d) => d.sourceDocumentId === "src-a");
    expect(primaryDraft).toBeDefined();
    if (!primaryDraft) throw new Error("expected primary draft");

    const finalize = await runner.finalize({
      approvals: [
        {
          sourceDocumentId: "src-a",
          ventureSlug: null,
          acceptedNoteIds: [primaryDraft.noteId],
        },
      ],
      now: NOW,
    });
    expect(finalize.notesWritten).toHaveLength(1);
    expect(finalize.notesWritten[0]?.noteId).toBe(primaryDraft.noteId);
  });

  it("throws when finalize() is called before run() completes", async () => {
    const runner = new VaultStageRunner({
      job: makeJob(),
      sources: [makeSource()],
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
    await expect(
      runner.finalize({ approvals: [], now: NOW })
    ).rejects.toThrow(/before run/);
  });
});
