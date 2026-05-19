import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseChatGptExport } from "../src/index";

const FIXTURE_PATH = join(__dirname, "fixtures", "chatgpt-export.json");

describe("parseChatGptExport", () => {
  it("walks the mapping tree to produce a chronological turn list", async () => {
    const raw = await readFile(FIXTURE_PATH, "utf8");
    const parsed = parseChatGptExport(raw);
    expect(parsed.extractionMethod).toBe("chat_chatgpt");
    const first = parsed.conversations.find((c) => c.id === "c-001");
    expect(first).toBeDefined();
    expect(first?.title).toBe("Pricing experiment");
    expect(first?.turns.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
    expect(first?.turns[0]?.content).toBe("What price should we test?");
    expect(first?.turns[2]?.createdAt).toBe(new Date(1715000200 * 1000).toISOString());
  });

  it("skips a malformed conversation but keeps the other 2 (slice-spec invariant)", async () => {
    const raw = await readFile(FIXTURE_PATH, "utf8");
    const parsed = parseChatGptExport(raw);
    expect(parsed.conversations.map((c) => c.id)).toEqual(["c-001", "c-003"]);
  });

  it("falls back to mapping insertion order when current_node is missing", () => {
    const raw = JSON.stringify([
      {
        id: "c-fallback",
        title: "No current_node",
        mapping: {
          n1: {
            id: "n1",
            parent: null,
            message: {
              author: { role: "user" },
              content: { content_type: "text", parts: ["alpha"] },
            },
          },
          n2: {
            id: "n2",
            parent: "n1",
            message: {
              author: { role: "assistant" },
              content: { content_type: "text", parts: ["beta"] },
            },
          },
        },
      },
    ]);
    const parsed = parseChatGptExport(raw);
    expect(parsed.conversations[0]?.turns.map((t) => t.content)).toEqual(["alpha", "beta"]);
  });

  it("throws ChatImporterError when the file isn't a JSON array", () => {
    expect(() => parseChatGptExport('{"oops":true}')).toThrow(/JSON array/);
  });

  it("throws ChatImporterError when the file isn't JSON", () => {
    expect(() => parseChatGptExport("not json")).toThrow(/not valid JSON/);
  });

  it("invariant: a single bad item in a 10-conversation export does not fail the other 9", () => {
    const conversations = Array.from({ length: 10 }, (_, i) => {
      if (i === 4) {
        return { id: `c-${i}`, title: `bad-${i}`, mapping: "not an object" };
      }
      return {
        id: `c-${i}`,
        title: `good-${i}`,
        current_node: "n1",
        mapping: {
          n1: {
            id: "n1",
            parent: null,
            message: {
              author: { role: "user" },
              content: { content_type: "text", parts: [`Q${i}`] },
            },
          },
        },
      };
    });
    const parsed = parseChatGptExport(JSON.stringify(conversations));
    expect(parsed.conversations).toHaveLength(9);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toMatch(/conversation #4 skipped/);
  });
});
