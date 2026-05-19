import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseClaudeJsonExport,
  parseClaudeMarkdownExport,
} from "../src/index";

const FIXTURES = join(__dirname, "fixtures");

describe("parseClaudeJsonExport", () => {
  it("parses the conversations.conversations array shape", async () => {
    const raw = await readFile(join(FIXTURES, "claude-export.json"), "utf8");
    const parsed = parseClaudeJsonExport(raw);
    expect(parsed.extractionMethod).toBe("chat_claude");
    expect(parsed.conversations).toHaveLength(1);
    const convo = parsed.conversations[0];
    expect(convo?.title).toBe("Brand naming");
    expect(convo?.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(convo?.turns[0]?.createdAt).toBe("2026-05-01T10:00:05Z");
  });

  it("also accepts a bare JSON array form", () => {
    const raw = JSON.stringify([
      {
        uuid: "x",
        name: "Bare array",
        chat_messages: [
          { sender: "human", text: "Hi" },
          { sender: "assistant", text: "Hello" },
        ],
      },
    ]);
    const parsed = parseClaudeJsonExport(raw);
    expect(parsed.conversations[0]?.title).toBe("Bare array");
    expect(parsed.conversations[0]?.turns).toHaveLength(2);
  });

  it("isolates a malformed conversation in a 10-conversation export", () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      i === 7
        ? { uuid: `bad-${i}`, chat_messages: "not an array" }
        : {
            uuid: `u-${i}`,
            name: `Convo ${i}`,
            chat_messages: [{ sender: "human", text: `q${i}` }],
          },
    );
    const parsed = parseClaudeJsonExport(JSON.stringify({ conversations: items }));
    expect(parsed.conversations).toHaveLength(9);
    expect(parsed.warnings[0]).toMatch(/conversation #7/);
  });
});

describe("parseClaudeMarkdownExport", () => {
  it("splits on --- and reads Human/Assistant labels", async () => {
    const raw = await readFile(join(FIXTURES, "claude-export.md"), "utf8");
    const parsed = parseClaudeMarkdownExport(raw);
    expect(parsed.conversations).toHaveLength(2);
    expect(parsed.conversations[0]?.title).toBe("Pricing brainstorm");
    expect(parsed.conversations[0]?.turns.map((t) => t.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(parsed.conversations[0]?.turns[1]?.content).toBe("Test $19, $29, and $49.");
  });

  it("treats blocks with no turn markers as skipped", () => {
    const raw = "# Title only\n\nNo turn markers here.\n---\n# Real\n\n**Human**\n\nHi";
    const parsed = parseClaudeMarkdownExport(raw);
    expect(parsed.conversations).toHaveLength(1);
    expect(parsed.conversations[0]?.title).toBe("Real");
  });
});
