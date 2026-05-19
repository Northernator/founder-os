import { describe, expect, it } from "vitest";
import {
  buildHeuristicItems,
  buildItemId,
  coercedToExtractedItem,
} from "../src/heuristics";
import type { HeuristicInput } from "../src/types";

const NOW = "2026-05-18T00:00:00.000Z";

function makeInput(over: Partial<HeuristicInput> = {}): HeuristicInput {
  return {
    sourceDocumentId: "src-1",
    projectId: null,
    sourceType: "document",
    title: "Notes from kickoff",
    markdown:
      "We met to discuss the launch. The brief is ready.\n\n- decided: ship on May 30\n- TODO: book design review\n- prompt: act as a product manager\n- noise that should not classify\n- question: who owns the press release?\n",
    summary: "Kickoff covered launch date and follow-ups.",
    now: NOW,
    ...over,
  };
}

describe("buildHeuristicItems", () => {
  it("returns one summary + classified bullets, all low-confidence", () => {
    const items = buildHeuristicItems(makeInput());
    const types = items.map((i) => i.type);
    expect(types[0]).toBe("summary");
    expect(types).toContain("decision");
    expect(types).toContain("task");
    expect(types).toContain("prompt");
    expect(types).toContain("question");
    for (const item of items) {
      expect(item.confidence).toBe("low");
      expect(item.status).toBe("suggested");
    }
  });

  it("falls back to the first paragraph when no summary is supplied", () => {
    const items = buildHeuristicItems(
      makeInput({ summary: undefined, markdown: "Opening paragraph here.\n\nLater detail." })
    );
    expect(items[0]?.content).toBe("Opening paragraph here.");
  });

  it("returns no summary when markdown is empty and summary is missing", () => {
    const items = buildHeuristicItems(
      makeInput({ summary: undefined, markdown: "" })
    );
    expect(items).toEqual([]);
  });

  it("classifies image sources as ui_reference by default", () => {
    const items = buildHeuristicItems(
      makeInput({ sourceType: "image", markdown: "A wireframe of the home screen." })
    );
    expect(items[0]?.type).toBe("ui_reference");
  });

  it("caps title length at 80 chars", () => {
    const long = `decided: ${"x".repeat(200)}`;
    const items = buildHeuristicItems(
      makeInput({ summary: undefined, markdown: `- ${long}` })
    );
    const decision = items.find((i) => i.type === "decision");
    expect(decision?.title.length).toBeLessThanOrEqual(80);
  });

  it("ignores noise bullets that match no keyword", () => {
    const items = buildHeuristicItems(
      makeInput({
        summary: undefined,
        markdown: "- random thought\n- weather today\n- nothing important",
      })
    );
    expect(items.length).toBeLessThanOrEqual(1); // only the summary, no bullet matches
  });
});

describe("buildItemId / coercedToExtractedItem", () => {
  it("emits stable per-source ids", () => {
    expect(buildItemId("src-7", 3)).toBe("src-7#3");
  });

  it("threads sourceDocumentId / projectId / now into the ExtractedItem", () => {
    const input = makeInput({ projectId: "venture-abc" });
    const coerced = buildHeuristicItems(input)[0];
    expect(coerced).toBeDefined();
    if (!coerced) throw new Error("expected at least one item");
    const item = coercedToExtractedItem(coerced, input, 0);
    expect(item.id).toBe("src-1#0");
    expect(item.sourceDocumentId).toBe("src-1");
    expect(item.projectId).toBe("venture-abc");
    expect(item.createdAt).toBe(NOW);
    expect(item.updatedAt).toBe(NOW);
  });
});
