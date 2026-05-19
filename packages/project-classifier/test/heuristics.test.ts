import { describe, expect, it } from "vitest";
import { buildHeuristicMatches, scoreCandidate } from "../src/heuristics";
import type { ClassifyDocumentInput, ProjectCandidate } from "../src/types";

const NOW = "2026-05-18T00:00:00.000Z";

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3)
  );
}

function makeInput(over: Partial<ClassifyDocumentInput> = {}): ClassifyDocumentInput {
  return {
    sourceDocumentId: "src-classifier",
    sourceTitle: "DreamLauncher pitch deck draft",
    sourceSummary: "Pitch deck for DreamLauncher AI startup studio.",
    sourceExcerpt:
      "DreamLauncher is the AI-first studio that helps founders ship startups in weeks. The brand is bold.",
    sourceType: "document",
    candidates: [],
    now: NOW,
    ...over,
  };
}

const CANDIDATES: ProjectCandidate[] = [
  {
    projectId: "v-dreamlauncher",
    name: "DreamLauncher",
    slug: "dreamlauncher",
    summary: "AI-first startup studio shipping ventures end-to-end.",
    keywords: "studio, founders, startup, ship",
  },
  {
    projectId: "v-paint-co",
    name: "Paint Co",
    slug: "paint-co",
    summary: "Wholesale paint distribution for trade customers.",
    keywords: "paint, trade, distribution",
  },
  {
    projectId: "v-orchid",
    name: "Orchid",
    slug: "orchid",
    summary: "Orchid cultivation hardware for hobbyists.",
    keywords: "orchid, hardware, hobby",
  },
];

describe("scoreCandidate", () => {
  it("scores higher on keyword overlap", () => {
    const sourceTokens = tokens(
      "DreamLauncher AI studio for founders shipping startups."
    );
    const dl = CANDIDATES[0];
    const paint = CANDIDATES[1];
    if (!dl || !paint) throw new Error("fixtures missing");
    expect(scoreCandidate(dl, sourceTokens)).toBeGreaterThan(
      scoreCandidate(paint, sourceTokens)
    );
  });

  it("returns 0 when source tokens are empty", () => {
    const dl = CANDIDATES[0];
    if (!dl) throw new Error("fixture missing");
    expect(scoreCandidate(dl, new Set())).toBe(0);
  });
});

describe("buildHeuristicMatches", () => {
  it("picks the best-overlap candidate at medium / low confidence", () => {
    const matches = buildHeuristicMatches(makeInput({ candidates: CANDIDATES }));
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0]?.projectId).toBe("v-dreamlauncher");
    expect(["medium", "low"]).toContain(matches[0]?.confidence);
    expect(matches[0]?.status).toBe("suggested");
  });

  it("returns a single unsorted/low match when nothing overlaps", () => {
    const matches = buildHeuristicMatches(
      makeInput({
        sourceTitle: "totally unrelated bookkeeping notes",
        sourceSummary: undefined,
        sourceExcerpt: "ledger entries and tax codes only.",
        candidates: CANDIDATES,
      })
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.projectId).toBeNull();
    expect(matches[0]?.status).toBe("unsorted");
    expect(matches[0]?.confidence).toBe("low");
  });

  it("handles empty candidate lists by returning unsorted/low", () => {
    const matches = buildHeuristicMatches(makeInput({ candidates: [] }));
    expect(matches).toHaveLength(1);
    expect(matches[0]?.status).toBe("unsorted");
  });

  it("ranks higher-overlap candidates first", () => {
    const matches = buildHeuristicMatches(makeInput({ candidates: CANDIDATES }));
    // We can't assume Paint Co is never returned, but DreamLauncher must come first.
    expect(matches[0]?.projectId).toBe("v-dreamlauncher");
  });
});
