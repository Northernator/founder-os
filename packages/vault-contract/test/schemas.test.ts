import { describe, expect, it } from "vitest";
import {
  ConfidenceSchema,
  ExtractedItemSchema,
  ExtractionMethodSchema,
  ImportJobSchema,
  ImportJobStatusSchema,
  ProjectMatchSchema,
  SourceDocumentSchema,
  SourceProviderSchema,
  VaultNoteFrontmatterSchema,
  VaultNoteSchema,
  VaultNoteTypeSchema,
} from "../src/index";

describe("vault-contract enums", () => {
  it("ImportJobStatusSchema accepts every documented lifecycle state", () => {
    for (const status of [
      "queued",
      "processing",
      "needs_review",
      "committed",
      "failed",
      "cancelled",
    ] as const) {
      expect(ImportJobStatusSchema.parse(status)).toBe(status);
    }
  });

  it("ImportJobStatusSchema rejects unknown states", () => {
    expect(() => ImportJobStatusSchema.parse("done")).toThrow();
  });

  it("SourceProviderSchema covers local + google_drive + paste + manual", () => {
    for (const p of ["local", "google_drive", "paste", "manual"] as const) {
      expect(SourceProviderSchema.parse(p)).toBe(p);
    }
  });

  it("VaultNoteTypeSchema covers every documented template kind", () => {
    for (const t of [
      "project_index",
      "chat_summary",
      "document_summary",
      "image_note",
      "decision_log",
      "task_list",
      "prompt_pack",
      "research_note",
      "brand_reference",
      "ui_reference",
      "raw_archive",
    ] as const) {
      expect(VaultNoteTypeSchema.parse(t)).toBe(t);
    }
  });

  it("ConfidenceSchema rejects free-form strings", () => {
    expect(ConfidenceSchema.parse("high")).toBe("high");
    expect(() => ConfidenceSchema.parse("very-high")).toThrow();
  });

  it("ExtractionMethodSchema includes the scanned-PDF handoff sentinel", () => {
    expect(ExtractionMethodSchema.parse("scanned_pdf_needs_ocr")).toBe(
      "scanned_pdf_needs_ocr",
    );
  });
});

describe("SourceDocumentSchema", () => {
  const base = {
    id: "src_1",
    importJobId: "job_1",
    sourceType: "document" as const,
    sourceProvider: "local" as const,
    originalName: "spec.pdf",
    cachedOriginalPath: "_vault/_import-cache/ab/cd.pdf",
    contentHash: "abcd".repeat(16),
    extractionStatus: "pending" as const,
    createdAt: "2026-05-18T08:00:00.000Z",
  };

  it("parses a minimal record", () => {
    const parsed = SourceDocumentSchema.parse(base);
    expect(parsed.id).toBe("src_1");
    expect(parsed.needsReview).toBe(false);
    expect(parsed.schemaVersion).toBe(1);
  });

  it("rejects missing originalName", () => {
    const { originalName: _omit, ...rest } = base;
    expect(() => SourceDocumentSchema.parse(rest)).toThrow();
  });
});

describe("ImportJobSchema", () => {
  it("defaults numeric counts to zero", () => {
    const parsed = ImportJobSchema.parse({
      id: "job_1",
      status: "queued",
      sourceProvider: "local",
      sourceMode: "files",
      createdAt: "2026-05-18T08:00:00.000Z",
      updatedAt: "2026-05-18T08:00:00.000Z",
    });
    expect(parsed.fileCount).toBe(0);
    expect(parsed.processedCount).toBe(0);
    expect(parsed.failedCount).toBe(0);
    expect(parsed.warningCount).toBe(0);
  });
});

describe("ProjectMatchSchema", () => {
  it("allows null projectId for unsorted matches", () => {
    const parsed = ProjectMatchSchema.parse({
      id: "m_1",
      sourceDocumentId: "src_1",
      projectId: null,
      confidence: "low",
      status: "unsorted",
      createdAt: "2026-05-18T08:00:00.000Z",
      updatedAt: "2026-05-18T08:00:00.000Z",
    });
    expect(parsed.projectId).toBeNull();
  });
});

describe("ExtractedItemSchema", () => {
  it("requires type + title + content + confidence", () => {
    const parsed = ExtractedItemSchema.parse({
      id: "i_1",
      sourceDocumentId: "src_1",
      projectId: null,
      type: "decision",
      title: "Pick a launch date",
      content: "Pick a launch date before EOQ.",
      confidence: "medium",
      status: "suggested",
      createdAt: "2026-05-18T08:00:00.000Z",
      updatedAt: "2026-05-18T08:00:00.000Z",
    });
    expect(parsed.type).toBe("decision");
  });
});

describe("VaultNoteSchema + Frontmatter", () => {
  it("round-trips frontmatter defaults", () => {
    const parsed = VaultNoteFrontmatterSchema.parse({
      title: "Spec notes",
      sourceDocumentId: "src_1",
      projectSlug: null,
      noteType: "document_summary",
      createdAt: "2026-05-18T08:00:00.000Z",
    });
    expect(parsed.tags).toEqual([]);
    expect(parsed.itemIds).toEqual([]);
  });

  it("VaultNoteSchema requires a markdownPath", () => {
    expect(() =>
      VaultNoteSchema.parse({
        id: "n_1",
        projectId: null,
        sourceDocumentId: "src_1",
        title: "x",
        noteType: "document_summary",
        status: "suggested",
        createdAt: "2026-05-18T08:00:00.000Z",
        updatedAt: "2026-05-18T08:00:00.000Z",
      }),
    ).toThrow();
  });
});
