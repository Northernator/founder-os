import { describe, expect, it } from "vitest";
import { detectFileType, extractExtension } from "../src/file-type";

describe("detectFileType", () => {
  it.each([
    ["spec.pdf", "pdf", "document"],
    ["notes.docx", "docx", "document"],
    ["notes.doc", "doc", "document"],
    ["readme.md", "md", "document"],
    ["readme.markdown", "markdown", "document"],
    ["plain.txt", "txt", "document"],
    ["page.html", "html", "document"],
    ["screenshot.png", "png", "image"],
    ["photo.jpg", "jpg", "image"],
    ["photo.jpeg", "jpeg", "image"],
    ["sticker.webp", "webp", "image"],
    ["scan.tiff", "tiff", "image"],
    ["data.csv", "csv", "spreadsheet"],
    ["data.tsv", "tsv", "spreadsheet"],
    ["data.xlsx", "xlsx", "spreadsheet"],
    ["config.json", "json", "structured"],
    ["config.yaml", "yaml", "structured"],
    ["mod.ts", "ts", "code"],
    ["mod.py", "py", "code"],
    ["subs.vtt", "vtt", "transcript"],
  ] as const)("maps %s -> %s", (originalName, fileExtension, expected) => {
    const result = detectFileType({ originalName, fileExtension });
    expect(result.sourceType).toBe(expected);
    expect(result.confidence).toBe("high");
  });

  it("classifies ChatGPT conversation exports as chat regardless of ext", () => {
    expect(
      detectFileType({ originalName: "conversations.json", fileExtension: "json" }).sourceType,
    ).toBe("chat");
    expect(
      detectFileType({
        originalName: "chatgpt-export-2026-05.json",
        fileExtension: "json",
      }).sourceType,
    ).toBe("chat");
    expect(
      detectFileType({
        originalName: "claude-export.md",
        fileExtension: "md",
      }).sourceType,
    ).toBe("chat");
  });

  it("falls back to mime-type when extension is unknown", () => {
    const result = detectFileType({
      originalName: "unknown",
      fileExtension: "",
      mimeType: "image/png",
    });
    expect(result.sourceType).toBe("image");
    expect(result.confidence).toBe("high");
  });

  it("treats text/* mime as document with medium confidence when ext missing", () => {
    const result = detectFileType({
      originalName: "notes",
      fileExtension: "",
      mimeType: "text/plain",
    });
    expect(result.sourceType).toBe("document");
    expect(result.confidence).toBe("medium");
  });

  it("returns other + low confidence for an unknown blob", () => {
    const result = detectFileType({ originalName: "blob.xyz", fileExtension: "xyz" });
    expect(result.sourceType).toBe("other");
    expect(result.confidence).toBe("low");
  });
});

describe("extractExtension", () => {
  it("returns lowercased extension without the dot", () => {
    expect(extractExtension("Notes.MD")).toBe("md");
    expect(extractExtension("photo.JPEG")).toBe("jpeg");
  });

  it("returns empty when there is no extension", () => {
    expect(extractExtension("Makefile")).toBe("");
    expect(extractExtension("LICENSE")).toBe("");
  });

  it("returns empty when name ends with a trailing dot", () => {
    expect(extractExtension("name.")).toBe("");
  });
});
