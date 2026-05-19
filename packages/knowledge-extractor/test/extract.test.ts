import { describe, expect, it } from "vitest";
import {
  coerceLlmItems,
  extractJsonArray,
  extractKnowledgeItems,
} from "../src/extract";
import type { KnowledgeCallLlm, KnowledgeExtractionInput } from "../src/types";

const NOW = "2026-05-18T00:00:00.000Z";

function makeInput(over: Partial<KnowledgeExtractionInput> = {}): KnowledgeExtractionInput {
  return {
    sourceDocumentId: "src-extract",
    projectId: null,
    sourceType: "document",
    title: "Launch playbook",
    markdown: "Launch sequence:\n- decided: ship May 30\n- TODO: brief PR contact\n",
    summary: "Launch sequence draft from the founder.",
    now: NOW,
    ...over,
  };
}

describe("extractJsonArray", () => {
  it("parses a bare JSON array", () => {
    expect(extractJsonArray('[{"a":1},{"b":2}]')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("strips a leading ```json fence", () => {
    expect(extractJsonArray('```json\n[1,2,3]\n```')).toEqual([1, 2, 3]);
  });

  it("locates a JSON array embedded in prose", () => {
    const raw = "Sure, here you go:\n\n[\"a\", \"b\"]\n\nLet me know if you need more.";
    expect(extractJsonArray(raw)).toEqual(["a", "b"]);
  });

  it("returns null for unparseable JSON", () => {
    expect(extractJsonArray("not JSON at all")).toBeNull();
    expect(extractJsonArray("[unterminated")).toBeNull();
  });

  it("handles literal ] characters inside strings", () => {
    const raw = '[{"title":"why [now]?","content":"x"}]';
    const parsed = extractJsonArray(raw);
    expect(parsed).toEqual([{ title: "why [now]?", content: "x" }]);
  });
});

describe("coerceLlmItems schema-drop", () => {
  it("keeps valid items and drops invalid ones with warnings", () => {
    const warnings: string[] = [];
    const items = coerceLlmItems(
      [
        { type: "decision", title: "Ship May 30", content: "Locked in.", confidence: "high" },
        { type: "invalid_kind", title: "x", content: "y" },
        { type: "task", title: "", content: "missing title" },
        { type: "task", title: "Book design review", content: "Send Susan the slot." },
      ],
      warnings
    );
    expect(items).toHaveLength(2);
    expect(items[0]?.type).toBe("decision");
    expect(items[1]?.type).toBe("task");
    expect(warnings[0]).toMatch(/dropped 2/);
  });

  it("defaults missing confidence to medium", () => {
    const items = coerceLlmItems(
      [{ type: "idea", title: "Pricing tier idea", content: "Try a $5 tier." }],
      []
    );
    expect(items[0]?.confidence).toBe("medium");
  });

  it("truncates over-long titles to 120 chars", () => {
    const items = coerceLlmItems(
      [
        {
          type: "fact",
          title: "x".repeat(200),
          content: "y",
        },
      ],
      []
    );
    expect(items[0]?.title.length).toBeLessThanOrEqual(120);
    expect(items[0]?.title.endsWith("...")).toBe(true);
  });
});

describe("extractKnowledgeItems", () => {
  it("uses heuristics when no callLlm is supplied", async () => {
    const result = await extractKnowledgeItems(makeInput());
    expect(result.usedLlm).toBe(false);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0]?.confidence).toBe("low");
    expect(result.items[0]?.id).toBe("src-extract#0");
  });

  it("uses heuristics when callLlm throws (and surfaces the error)", async () => {
    const callLlm: KnowledgeCallLlm = async () => {
      throw new Error("transport down");
    };
    const result = await extractKnowledgeItems(makeInput(), callLlm);
    expect(result.usedLlm).toBe(false);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/LLM call failed: transport down/)])
    );
    expect(result.items.length).toBeGreaterThan(0);
  });

  it("uses heuristics when every LLM item is schema-invalid", async () => {
    const callLlm: KnowledgeCallLlm = async () =>
      JSON.stringify([{ type: "not_a_kind", title: "x", content: "y" }]);
    const result = await extractKnowledgeItems(makeInput(), callLlm);
    expect(result.usedLlm).toBe(false);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/dropped 1/)])
    );
    expect(result.notes).toEqual(
      expect.arrayContaining([expect.stringMatching(/deterministic fallback/)])
    );
    // Heuristic items still come back so the runner has something to write.
    expect(result.items.length).toBeGreaterThan(0);
  });

  it("keeps schema-valid LLM items and marks usedLlm=true", async () => {
    const callLlm: KnowledgeCallLlm = async () =>
      JSON.stringify([
        {
          type: "decision",
          title: "Ship May 30",
          content: "Final answer.",
          confidence: "high",
        },
        {
          type: "task",
          title: "Brief PR contact",
          content: "Email Susan.",
          confidence: "medium",
        },
      ]);
    const result = await extractKnowledgeItems(makeInput(), callLlm);
    expect(result.usedLlm).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.confidence).toBe("high");
    expect(result.items[1]?.confidence).toBe("medium");
    expect(result.items[0]?.status).toBe("suggested");
  });

  it("partial-recovery: drops bad items but keeps usedLlm=true when good ones survive", async () => {
    const callLlm: KnowledgeCallLlm = async () =>
      JSON.stringify([
        { type: "decision", title: "Lock launch date", content: "May 30." },
        { type: "invalid", title: "x", content: "y" },
        { type: "task", title: "Schedule retro", content: "Friday at 4." },
      ]);
    const result = await extractKnowledgeItems(makeInput(), callLlm);
    expect(result.usedLlm).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.warnings.some((w) => /dropped 1/.test(w))).toBe(true);
  });

  it("respects maxItems cap", async () => {
    const items = Array.from({ length: 20 }, (_v, i) => ({
      type: "fact",
      title: `Fact ${i}`,
      content: `Body ${i}`,
      confidence: "low",
    }));
    const callLlm: KnowledgeCallLlm = async () => JSON.stringify(items);
    const result = await extractKnowledgeItems(
      makeInput({ maxItems: 5 }),
      callLlm
    );
    expect(result.items).toHaveLength(5);
  });

  it("surfaces a warning when the LLM returns non-array prose", async () => {
    const callLlm: KnowledgeCallLlm = async () => "I cannot do that, Dave.";
    const result = await extractKnowledgeItems(makeInput(), callLlm);
    expect(result.usedLlm).toBe(false);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/did not contain a JSON array/)])
    );
  });

  it("threads projectId into every emitted item", async () => {
    const result = await extractKnowledgeItems(
      makeInput({ projectId: "venture-zzz" })
    );
    expect(result.items.every((i) => i.projectId === "venture-zzz")).toBe(true);
  });
});
