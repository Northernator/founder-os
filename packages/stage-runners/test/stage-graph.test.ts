/**
 * StageGraph self-consistency tests (pipeline-hardening, 2026-05-18).
 *
 * The StageGraph in @founder-os/domain replaces several scattered
 * surfaces (STAGE_NAME_ORDER, STAGE_PRODUCES, DEFAULT_REVIEW_GATES,
 * the desktop run-all-stages STAGE_ORDER). These tests assert the graph
 * stays consistent with the long-standing exports so adopting it in a
 * caller doesn't change semantics by accident.
 *
 * Specifically:
 *   1. STAGE_GRAPH covers every StageName in STAGE_NAME_ORDER exactly
 *      once -- no missing entries, no duplicates.
 *   2. STAGE_GRAPH.producedVentureStage matches STAGE_PRODUCES for
 *      every stage (the new metadata mirrors the old enum bridge).
 *   3. defaultReviewGate==true matches DEFAULT_REVIEW_GATES exactly
 *      (today: BRAND + AUDIT).
 *   4. providerRequired==true is exactly RESEARCH + BRAND. Every other
 *      stage has a deterministic fallback path in its runner -- the
 *      pipeline-hardening fix #4 dropped the desktop helpers' early
 *      "no-provider" bail for the 4 LLM-aware-but-deterministic stages.
 *   5. topologicalStageOrder() includes BACKEND (regression test for
 *      pipeline-hardening fix #3 -- BACKEND used to be omitted from
 *      run-all-stages).
 *   6. topologicalStageOrder() respects every node's dependencies:
 *      each stage appears after all its declared dependencies.
 *   7. No dependency points at an undefined StageName.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_GATES,
  STAGE_GRAPH,
  STAGE_NAME_ORDER,
  STAGE_PRODUCES,
  type StageName,
  defaultReviewGateStages,
  getStageGraphNode,
  providerRequiredStages,
  stagesProducedByVentureStage,
  topologicalStageOrder,
} from "@founder-os/domain";

describe("StageGraph coverage", () => {
  it("has a node for every StageName in STAGE_NAME_ORDER", () => {
    const graphIds = new Set(STAGE_GRAPH.map((n) => n.id));
    for (const stage of STAGE_NAME_ORDER) {
      expect(graphIds.has(stage), `missing graph node for ${stage}`).toBe(true);
    }
  });

  it("every node id is a known StageName (no extras)", () => {
    const orderSet = new Set<StageName>(STAGE_NAME_ORDER);
    for (const node of STAGE_GRAPH) {
      expect(orderSet.has(node.id), `unknown StageName ${node.id} in graph`).toBe(true);
    }
  });

  it("contains no duplicate ids", () => {
    const ids = STAGE_GRAPH.map((n) => n.id);
    const unique = new Set(ids);
    expect(ids.length).toBe(unique.size);
  });
});

describe("StageGraph parity with legacy bridges", () => {
  it("producedVentureStage matches STAGE_PRODUCES for every stage", () => {
    for (const node of STAGE_GRAPH) {
      expect(node.producedVentureStage).toBe(STAGE_PRODUCES[node.id]);
    }
  });

  it("defaultReviewGate==true matches DEFAULT_REVIEW_GATES exactly", () => {
    const fromGraph = new Set(defaultReviewGateStages());
    const fromConst = new Set(DEFAULT_REVIEW_GATES);
    expect(fromGraph).toEqual(fromConst);
  });

  it("providerRequired==true is exactly RESEARCH + BRAND", () => {
    const required = new Set(providerRequiredStages());
    expect(required).toEqual(new Set<StageName>(["RESEARCH", "BRAND"]));
  });
});

describe("StageGraph topological order", () => {
  it("includes BACKEND (pipeline-hardening fix #3 regression guard)", () => {
    const order = topologicalStageOrder();
    expect(order).toContain("BACKEND");
  });

  it("includes every stage exactly once", () => {
    const order = topologicalStageOrder();
    const unique = new Set(order);
    expect(order.length).toBe(STAGE_GRAPH.length);
    expect(unique.size).toBe(STAGE_GRAPH.length);
  });

  it("respects every node's declared dependencies", () => {
    const order = topologicalStageOrder();
    const positions = new Map<StageName, number>();
    order.forEach((s, i) => positions.set(s, i));
    for (const node of STAGE_GRAPH) {
      const nodePos = positions.get(node.id);
      expect(nodePos, `node ${node.id} missing from topo order`).toBeDefined();
      for (const dep of node.dependencies) {
        const depPos = positions.get(dep);
        expect(depPos, `dep ${dep} of ${node.id} not in topo order`).toBeDefined();
        if (depPos !== undefined && nodePos !== undefined) {
          expect(depPos).toBeLessThan(nodePos);
        }
      }
    }
  });

  it("BACKEND comes before BUILD (build reads backend-export.json)", () => {
    const order = topologicalStageOrder();
    expect(order.indexOf("BACKEND")).toBeLessThan(order.indexOf("BUILD"));
  });

  it("HANDOFF comes before BACKEND (backend consumes handoff-export.json)", () => {
    const order = topologicalStageOrder();
    expect(order.indexOf("HANDOFF")).toBeLessThan(order.indexOf("BACKEND"));
  });
});

describe("StageGraph integrity", () => {
  it("no dependency points at an undefined StageName", () => {
    const ids = new Set<StageName>(STAGE_GRAPH.map((n) => n.id));
    for (const node of STAGE_GRAPH) {
      for (const dep of node.dependencies) {
        expect(ids.has(dep), `${node.id} depends on undefined stage ${dep}`).toBe(true);
      }
    }
  });

  it("getStageGraphNode returns the right node for every StageName", () => {
    for (const stage of STAGE_NAME_ORDER) {
      const node = getStageGraphNode(stage);
      expect(node?.id).toBe(stage);
    }
  });

  it("stagesProducedByVentureStage handles BRAND_READY's two producers", () => {
    // BRAND + FINANCE both stamp BRAND_READY by design.
    const producers = new Set(stagesProducedByVentureStage("BRAND_READY"));
    expect(producers).toEqual(new Set<StageName>(["BRAND", "FINANCE"]));
  });

  it("every node has a non-empty label and folder", () => {
    for (const node of STAGE_GRAPH) {
      expect(node.label.length).toBeGreaterThan(0);
      expect(node.folder.length).toBeGreaterThan(0);
    }
  });
});
