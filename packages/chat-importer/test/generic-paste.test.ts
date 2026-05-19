import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  looksLikeChatTranscript,
  parseGenericTranscript,
  parsePastedText,
  renderConversationToMarkdown,
} from "../src/index";

const FIXTURE = join(__dirname, "fixtures", "generic-transcript.md");

describe("parseGenericTranscript", () => {
  it("parses a single-turn transcript", async () => {
    const raw = await readFile(FIXTURE, "utf8");
    const parsed = parseGenericTranscript({ text: raw });
    expect(parsed.conversations[0]?.title).toBe("Quick note");
    expect(parsed.conversations[0]?.turns[0]?.role).toBe("user");
    expect(parsed.conversations[0]?.turns[0]?.content).toBe(
      "Should we launch this Friday?",
    );
  });

  it("recognises multiple speakers + inline content", () => {
    const text = [
      "User: Should we A/B test this?",
      "Assistant: Yes, with 1k users per cell.",
      "User: For how long?",
      "Assistant: 14 days.",
    ].join("\n");
    const parsed = parseGenericTranscript({ text });
    expect(parsed.conversations[0]?.turns.map((t) => t.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("warns when no recognisable speakers are found", () => {
    const parsed = parseGenericTranscript({ text: "Just a wall of prose with no labels." });
    expect(parsed.warnings.length).toBeGreaterThan(0);
    expect(parsed.conversations[0]?.turns[0]?.role).toBe("other");
  });
});

describe("looksLikeChatTranscript", () => {
  it("returns true for two-plus turn markers", () => {
    expect(looksLikeChatTranscript("User: hi\nAssistant: hello there")).toBe(true);
  });
  it("returns false for plain prose", () => {
    expect(looksLikeChatTranscript("A whole paragraph of prose with no labels.")).toBe(false);
  });
});

describe("parsePastedText", () => {
  it("uses generic-transcript routing when the paste smells like chat", () => {
    const parsed = parsePastedText({
      text: "User: hi\nAssistant: hello",
    });
    expect(parsed.extractionMethod).toBe("paste_text");
    expect(parsed.conversations[0]?.turns).toHaveLength(2);
  });

  it("wraps plain prose as a single other-role turn", () => {
    const parsed = parsePastedText({
      text: "I want to launch by Friday but the design needs another pass.",
    });
    expect(parsed.conversations[0]?.turns).toHaveLength(1);
    expect(parsed.conversations[0]?.turns[0]?.role).toBe("other");
    expect(parsed.conversations[0]?.title).toMatch(/launch by Friday/);
  });

  it("returns no conversations for empty paste", () => {
    const parsed = parsePastedText({ text: "  \n\n  " });
    expect(parsed.conversations).toHaveLength(0);
    expect(parsed.warnings).toContain("pasted text was empty");
  });
});

describe("renderConversationToMarkdown", () => {
  it("emits a # title + bold role labels + turn content", () => {
    const md = renderConversationToMarkdown({
      id: "x",
      title: "Pricing brainstorm",
      turns: [
        { role: "user", content: "what price?" },
        { role: "assistant", content: "try $29" },
      ],
    });
    expect(md).toContain("# Pricing brainstorm");
    expect(md).toContain("**User**");
    expect(md).toContain("what price?");
    expect(md).toContain("**Assistant**");
  });
});
