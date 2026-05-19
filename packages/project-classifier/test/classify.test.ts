import { describe, expect, it } from "vitest";
import {
  classifyDocument,
  coerceLlmScores,
  extractJsonArray,
} from "../src/classify";
import type {
  ClassifierCallLlm,
  ClassifyDocumentInput,
  ProjectCandidate,
} from "../src/types";

const NOW = "2026-05-18T00:00:00.000Z";

const CANDIDATES: ProjectCandidate[] = [
  {
    projectId: "v-dreamlauncher",
    name: "DreamLauncher",
    slug: "dreamlauncher",
    summary: "AI-first studio.",
  },
  {
    projectId: "v-paint-co",
    name: "Paint Co",
    slug: "paint-co",
    summary: "Wholesale paint distribution.",
  },
];

function makeInput(over: Partial<ClassifyDocumentInput> = {}): ClassifyDocumentInput {
  return {
    sourceDocumentId: "src-c",
    sourceTitle: "DreamLauncher pitch deck draft",
    sourceSummary: "Pitch deck for DreamLauncher.",
    sourceExcerpt: "DreamLauncher is the AI-first studio for founders shipping startups.",
    sourceType: "document",
    candidates: CANDIDATES,
    now: NOW,
    ...over,
  };
}

describe("extractJsonArray", () => {
  it("parses fenced JSON", () => {
    expect(extractJsonArray('```json\n[1,2]\n```')).toEqual([1, 2]);
  });

  it("returns null for prose with no array", () => {
    expect(extractJsonArray("no JSON here, sorry")).toBeNull();
  });
});

describe("coerceLlmScores", () => {
  it("keeps valid scores and drops invalid ones with warnings", () => {
    const warnings: string[] = [];
    const matches = coerceLlmScores(
      [
        {
          projectId: "v-dreamlauncher",
          confidence: "high",
          reason: "Title matches.",
        },
        { projectId: "", confidence: "high" }, // empty projectId
        { projectId: "v-dreamlauncher", confidence: "wat" }, // bad enum
        {
          projectId: "unsorted",
          confidence: "low",
          suggestedProjectName: "Side Project X",
        },
      ],
      new Set(["v-dreamlauncher", "v-paint-co"]),
      warnings
    );
    expect(matches).toHaveLength(2);
    expect(matches[0]?.projectId).toBe("v-dreamlauncher");
    expect(matches[0]?.status).toBe("suggested");
    expect(matches[1]?.projectId).toBeNull();
    expect(matches[1]?.status).toBe("unsorted");
    expect(matches[1]?.suggestedProjectName).toBe("Side Project X");
    expect(warnings.some((w) => /dropped 2 schema-invalid/.test(w))).toBe(true);
  });

  it("drops scores pointing at unknown projectIds", () => {
    const warnings: string[] = [];
    const matches = coerceLlmScores(
      [
        { projectId: "v-not-real", confidence: "high" },
        { projectId: "v-paint-co", confidence: "medium" },
      ],
      new Set(["v-dreamlauncher", "v-paint-co"]),
      warnings
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.projectId).toBe("v-paint-co");
    expect(warnings.some((w) => /unknown projectIds/.test(w))).toBe(true);
  });

  it("preserves confidence levels verbatim from the LLM", () => {
    const matches = coerceLlmScores(
      [
        { projectId: "v-dreamlauncher", confidence: "high" },
        { projectId: "v-paint-co", confidence: "low" },
        { projectId: "unsorted", confidence: "medium" },
      ],
      new Set(["v-dreamlauncher", "v-paint-co"]),
      []
    );
    expect(matches.map((m) => m.confidence)).toEqual(["high", "low", "medium"]);
  });
});

describe("classifyDocument", () => {
  it("uses heuristics when no callLlm is supplied", async () => {
    const result = await classifyDocument(makeInput());
    expect(result.usedLlm).toBe(false);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]?.projectId).toBe("v-dreamlauncher");
    expect(result.matches[0]?.id).toBe("src-c:match:0");
  });

  it("uses heuristics when callLlm throws (warning surfaced)", async () => {
    const callLlm: ClassifierCallLlm = async () => {
      throw new Error("transport down");
    };
    const result = await classifyDocument(makeInput(), callLlm);
    expect(result.usedLlm).toBe(false);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/LLM call failed/)])
    );
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it("uses heuristics when every LLM score is schema-invalid", async () => {
    const callLlm: ClassifierCallLlm = async () =>
      JSON.stringify([
        { projectId: "v-dreamlauncher", confidence: "best-ever" }, // bad enum
        { projectId: "v-not-real", confidence: "high" }, // unknown id
      ]);
    const result = await classifyDocument(makeInput(), callLlm);
    expect(result.usedLlm).toBe(false);
    expect(result.notes).toEqual(
      expect.arrayContaining([expect.stringMatching(/deterministic fallback/)])
    );
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it("keeps schema-valid LLM scores and marks usedLlm=true", async () => {
    const callLlm: ClassifierCallLlm = async () =>
      JSON.stringify([
        {
          projectId: "v-dreamlauncher",
          confidence: "high",
          reason: "Title and excerpt explicitly mention DreamLauncher.",
        },
      ]);
    const result = await classifyDocument(makeInput(), callLlm);
    expect(result.usedLlm).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.confidence).toBe("high");
    expect(result.matches[0]?.reason).toMatch(/DreamLauncher/);
  });

  it("partial recovery: keeps usedLlm=true when at least one score survives", async () => {
    const callLlm: ClassifierCallLlm = async () =>
      JSON.stringify([
        { projectId: "v-not-real", confidence: "high" }, // dropped
        { projectId: "v-dreamlauncher", confidence: "medium", reason: "match" },
      ]);
    const result = await classifyDocument(makeInput(), callLlm);
    expect(result.usedLlm).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.warnings.some((w) => /unknown projectIds/.test(w))).toBe(true);
  });

  it("threads createdAt/updatedAt and a stable match id", async () => {
    const result = await classifyDocument(makeInput({ sourceDocumentId: "abc" }));
    expect(result.matches[0]?.id).toMatch(/^abc:match:0$/);
    expect(result.matches[0]?.createdAt).toBe(NOW);
    expect(result.matches[0]?.updatedAt).toBe(NOW);
  });

  it("supports the LLM proposing a brand-new venture via unsorted+suggestedProjectName", async () => {
    const callLlm: ClassifierCallLlm = async () =>
      JSON.stringify([
        {
          projectId: "unsorted",
          confidence: "medium",
          reason: "Looks like a new product idea, not yet a venture.",
          suggestedProjectName: "Sunset Studio",
        },
      ]);
    const result = await classifyDocument(makeInput(), callLlm);
    expect(result.usedLlm).toBe(true);
    expect(result.matches[0]?.projectId).toBeNull();
    expect(result.matches[0]?.status).toBe("unsorted");
    expect(result.matches[0]?.suggestedProjectName).toBe("Sunset Studio");
  });

  it("surfaces a warning when the LLM returns non-array prose", async () => {
    const callLlm: ClassifierCallLlm = async () => "Sorry, I cannot do that.";
    const result = await classifyDocument(makeInput(), callLlm);
    expect(result.usedLlm).toBe(false);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/did not contain a JSON array/)])
    );
  });
});
