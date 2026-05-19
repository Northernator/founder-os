import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseChatGptExport } from "../src/index";

const FIXTURE_PATH = join(__dirname, "fixtures", "chatgpt-export.json");
const SINGLE_CONVERSATION_FIXTURE_PATH = join(
  __dirname,
  "fixtures",
  "chatgpt-single-conversation.json",
);

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

  it("accepts a single-conversation object with a top-level `mapping` field", async () => {
    // Some users keep per-conversation UUID-named files instead of the
    // canonical `conversations.json` array. Pre-fix, these hit the
    // runner's chatgpt -> claude -> paste fallback chain and produced
    // empty output because none of the parsers recognised the shape.
    const raw = await readFile(SINGLE_CONVERSATION_FIXTURE_PATH, "utf8");
    const parsed = parseChatGptExport(raw);
    expect(parsed.extractionMethod).toBe("chat_chatgpt");
    expect(parsed.conversations).toHaveLength(1);
    const convo = parsed.conversations[0];
    expect(convo?.id).toBe("c-single");
    expect(convo?.title).toBe("Per-conversation UUID file");
    expect(convo?.turns.map((t) => t.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(convo?.turns.map((t) => t.content)).toEqual([
      "What's the pricing test variant?",
      "Run A at $19 vs B at $29 for two weeks.",
      "Sample size?",
      "~1,200 visitors per arm at p=0.05.",
    ]);
    // Parent-link walk should produce strictly increasing create_time
    // across the turns -- confirms the chronological reverse worked.
    const times = convo?.turns.map((t) =>
      t.createdAt ? Date.parse(t.createdAt) : 0,
    );
    expect(times).toEqual([...(times ?? [])].sort((a, b) => a - b));
    expect(parsed.warnings).toHaveLength(0);
  });

  it("throws ChatImporterError when the file isn't a JSON array or single conversation", () => {
    // Object without a `mapping` property -- doesn't match either
    // supported shape, so the parser surfaces the contract clearly.
    expect(() => parseChatGptExport('{"oops":true}')).toThrow(/JSON array|mapping/);
  });

  it("throws when fed a Claude-shaped JSON array (every item lacks `mapping`)", () => {
    // Regression test for the run-vault-import chatPort cascade bug:
    // Claude exports are arrays too, so the outer `Array.isArray`
    // check passes, but every item lacks `mapping`. Before the
    // all-bad guard, the parser returned `{ conversations: [],
    // warnings: ["#0 skipped: missing mapping", ...] }` -- the
    // cascade saw a successful return and never fell through to
    // the Claude parser. Now it throws so the cascade routes
    // correctly + the deterministic sniff catches the case before
    // the cascade ever runs.
    const claudeShape = JSON.stringify([
      {
        uuid: "u-1",
        name: "Brand naming",
        chat_messages: [
          { sender: "human", text: "Suggest five names." },
          { sender: "assistant", text: "Acme, Beta, Calo, Delta, Echo." },
        ],
      },
      {
        uuid: "u-2",
        name: "Pricing test",
        chat_messages: [
          { sender: "human", text: "What variant should we run?" },
          { sender: "assistant", text: "A at $19 vs B at $29." },
        ],
      },
    ]);
    expect(() => parseChatGptExport(claudeShape)).toThrow(/no usable conversations/);
    // Sanity: the same input parsed via the Claude parser would
    // succeed -- this is an "asked the wrong parser" failure mode,
    // not a corrupt-file failure mode.
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
