import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractCsv,
  extractHtml,
  extractJson,
  extractMarkdown,
  extractText,
} from "../src/index";

const FIXTURES = join(__dirname, "fixtures");

async function readFixture(name: string): Promise<string> {
  return await readFile(join(FIXTURES, name), "utf8");
}

describe("extractMarkdown", () => {
  it("preserves fenced code + headings + bullets", async () => {
    const text = await readFixture("sample.md");
    const result = extractMarkdown({ text });
    expect(result.markdown).toContain("# Sample Note");
    expect(result.markdown).toContain("```ts");
    expect(result.confidence).toBe("high");
    expect(result.extractionMethod).toBe("markdown_native");
  });

  it("flags empty input as needs_review", () => {
    const result = extractMarkdown({ text: "   \n\n  " });
    expect(result.confidence).toBe("low");
    expect(result.needsReview).toBe(true);
  });

  it("strips embedded <script> blocks + warns", () => {
    const result = extractMarkdown({
      text: "# OK\n\n<script>alert(1)</script>\n\nBody",
    });
    expect(result.markdown).not.toContain("alert(1)");
    expect(result.warnings).toContain("removed <script> blocks");
  });

  it("clamps very deep headings", () => {
    const result = extractMarkdown({ text: "###### h6\n####### h7" });
    expect(result.markdown).not.toContain("#######");
  });
});

describe("extractText", () => {
  it("returns trimmed text", async () => {
    const text = await readFixture("sample.txt");
    const result = extractText({ text });
    expect(result.markdown.startsWith("This is plain text.")).toBe(true);
    expect(result.confidence).toBe("high");
  });

  it("flags binary noise as medium confidence + needs_review", () => {
    const noisy = `valid ascii then ${String.fromCharCode(0)}${String.fromCharCode(
      1,
    )}${String.fromCharCode(2)}${String.fromCharCode(3)}${String.fromCharCode(
      4,
    )}${String.fromCharCode(5)}`;
    const result = extractText({ text: noisy });
    expect(result.needsReview).toBe(true);
    expect(result.warnings.some((w) => /non-printable/.test(w))).toBe(true);
  });

  it("flags empty input", () => {
    const result = extractText({ text: "" });
    expect(result.confidence).toBe("low");
    expect(result.needsReview).toBe(true);
  });
});

describe("extractHtml", () => {
  it("converts headings, paragraphs, lists, and links", async () => {
    const text = await readFixture("sample.html");
    const result = extractHtml({ text });
    expect(result.markdown).toContain("# Headline");
    expect(result.markdown).toContain("**world**");
    expect(result.markdown).toContain("[the link](https://example.com)");
    expect(result.markdown).toContain("- alpha");
    expect(result.markdown).not.toContain("console.log");
  });

  it("flags tag-soup with no extractable text", () => {
    const result = extractHtml({ text: "<div><span></span></div>" });
    expect(result.needsReview).toBe(true);
  });

  it("decodes common entities", () => {
    const result = extractHtml({ text: "<p>a &amp; b &lt; c</p>" });
    expect(result.markdown).toContain("a & b < c");
  });
});

describe("extractCsv", () => {
  it("emits a markdown table for the happy path", async () => {
    const text = await readFixture("sample.csv");
    const result = extractCsv({ text });
    expect(result.markdown).toContain("| name | city | role |");
    expect(result.markdown).toContain("| Alice | London | Founder |");
    expect(result.confidence).toBe("high");
  });

  it("warns on ragged rows", () => {
    const result = extractCsv({ text: "a,b,c\n1,2\n4,5,6,7" });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.confidence).toBe("medium");
  });

  it("flags empty input", () => {
    const result = extractCsv({ text: "" });
    expect(result.confidence).toBe("low");
    expect(result.needsReview).toBe(true);
  });

  it("autodetects tab delimiter", () => {
    const result = extractCsv({ text: "a\tb\tc\n1\t2\t3" });
    expect(result.markdown).toContain("| 1 | 2 | 3 |");
  });
});

describe("extractJson", () => {
  it("pretty-prints valid JSON", async () => {
    const text = await readFixture("sample.json");
    const result = extractJson({ text });
    expect(result.markdown).toContain('"name": "Acme"');
    expect(result.markdown).toContain('"stages":');
    expect(result.summary).toMatch(/3 top-level keys/);
  });

  it("falls through on malformed JSON with needs_review", () => {
    const result = extractJson({ text: "{not: json}" });
    expect(result.confidence).toBe("low");
    expect(result.needsReview).toBe(true);
    expect(result.warnings.some((w) => /JSON parse failed/.test(w))).toBe(true);
  });
});
