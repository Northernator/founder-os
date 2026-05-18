/**
 * markdownToHtml tests. Covers the markdown-subset behaviour the
 * renderer relies on. Tier-D templates lean heavily on headers +
 * lists + bold/italic, so those get the focus.
 */
import { describe, expect, it } from "vitest";
import { markdownToHtml } from "../src/index.js";

describe("markdownToHtml", () => {
  it("converts headers, paragraphs, and lists", () => {
    const html = markdownToHtml(
      [
        "# Title",
        "",
        "A paragraph with **bold** and *italic* text.",
        "",
        "- one",
        "- two",
        "",
        "1. first",
        "2. second",
      ].join("\n")
    );
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<ol><li>first</li><li>second</li></ol>");
  });

  it("preserves hp-todo callouts emitted by lenient template renders", () => {
    const todoSpan =
      '<span class="hp-todo" data-placeholder="COMPANY_NAME">TODO: COMPANY_NAME</span>';
    const html = markdownToHtml(`Hello ${todoSpan}.`);
    // The span must survive the markdown transform unchanged.
    expect(html).toContain(todoSpan);
  });
});
