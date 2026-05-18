/**
 * StageGraph (pipeline-hardening, 2026-05-18)
 *
 * One canonical metadata table for every pipeline stage. The existing
 * scattered surfaces — STAGE_NAME_ORDER, STAGE_PRODUCES,
 * DEFAULT_REVIEW_GATES, the desktop's local STAGE_ORDER array, the
 * folder-string convention in workspace-core/STAGE_DIRS, per-tab
 * adoption flags — all describe the same underlying graph but drift
 * because there's no single record. This file is that record.
 *
 * Each StageGraphNode captures:
 *   - id                     the StageName enum value
 *   - label                  human-readable name for UI
 *   - folder                 venture-root-relative folder where the
 *                            stage's primary artifacts land (string
 *                            literal so this file stays bottom-layer
 *                            with no workspace-core dependency)
 *   - dependencies           stages that must complete before this one
 *                            (used by topologicalStageOrder; an empty
 *                            list means "runs in parallel / no deps")
 *   - producedVentureStage   the VentureStage marker stamped on the
 *                            venture after this stage succeeds
 *                            (mirrors STAGE_PRODUCES)
 *   - defaultReviewGate      whether the runner emits a review gate
 *                            on success by default (BRAND, AUDIT today;
 *                            CRM emits one conditionally at runtime so
 *                            its default stays false)
 *   - providerRequired       whether the stage REQUIRES an LLM provider
 *                            (true = no deterministic fallback). After
 *                            the pipeline-hardening pass:
 *                              true  for RESEARCH, BRAND
 *                              false for everything else (deterministic
 *                                    fallback path exists in the runner)
 *   - tabOwner               apps/founder-desktop tab that hosts the
 *                            "Run X stage" button for this stage
 *
 * What this file does NOT replace yet (back-compat is preserved):
 *   - STAGE_NAME_ORDER       still the canonical linear iteration order
 *   - STAGE_PRODUCES         still exported; mirrors producedVentureStage
 *   - DEFAULT_REVIEW_GATES   still exported; mirrors defaultReviewGate
 *
 * Migration plan: callers can move to STAGE_GRAPH at their own pace.
 * The derivations exported below (topologicalStageOrder,
 * getStageGraphNode, stagesProducedByVentureStage) make adoption a
 * one-line swap.
 */
import type { StageName } from "./stage-runners.js";

// Local literal to avoid circular import on VentureStageSchema.
// Mirrors the VentureStageSchema enum in ./index.ts.
type VentureStageMarker =
  | "IDEA"
  | "RESEARCHED"
  | "VALIDATED"
  | "BRAND_READY"
  | "UK_SETUP_READY"
  | "SPEC_READY"
  | "WIREFRAME_READY"
  | "STITCH_READY"
  | "BACKEND_READY"
  | "BUILD_READY"
  | "AUDIT_READY"
  | "LAUNCH_READY"
  | "MEDIA_READY"
  | "MEDIA_EDIT_READY"
  | "CRM_READY"
  | "HANDOFF_PACK_READY"
  | "LIVE";

export interface StageGraphNode {
  id: StageName;
  label: string;
  folder: string;
  dependencies: StageName[];
  producedVentureStage: VentureStageMarker;
  defaultReviewGate: boolean;
  providerRequired: boolean;
  tabOwner: string;
}

/**
 * Canonical metadata for every implemented pipeline stage. Folders use
 * the existing numbered convention documented in workspace-core/paths.ts
 * and the various MODULE-SPEC.md files under bizBuild/.
 *
 * Notable shapes:
 *   - FINANCE.producedVentureStage = BRAND_READY is preserved from the
 *     existing STAGE_PRODUCES table. It is "parallel to brand;
 *     doesn't advance the gate" per the stage-runners pt source. A
 *     future cleanup may split this into a dedicated FINANCE_READY
 *     marker — for now the StageGraph mirrors the existing behavior so
 *     this addition is non-breaking.
 *   - HANDOFF.producedVentureStage = STITCH_READY is back-compat naming
 *     drift (the dual-handoff arc kept the marker constant so existing
 *     venture data stays parseable). The StageName is HANDOFF.
 */
export const STAGE_GRAPH: readonly StageGraphNode[] = [
  {
    id: "RESEARCH",
    label: "Research",
    folder: "01_research",
    dependencies: [],
    producedVentureStage: "RESEARCHED",
    defaultReviewGate: false,
    providerRequired: true,
    tabOwner: "ResearchTab",
  },
  {
    id: "VALIDATION",
    label: "Validation",
    folder: "02_validation",
    dependencies: ["RESEARCH"],
    producedVentureStage: "VALIDATED",
    defaultReviewGate: false,
    providerRequired: false,
    tabOwner: "ValidationTab",
  },
  {
    id: "BRAND",
    label: "Brand",
    folder: "03_brand",
    dependencies: ["VALIDATION"],
    producedVentureStage: "BRAND_READY",
    defaultReviewGate: true,
    providerRequired: true,
    tabOwner: "BrandTab",
  },
  {
    id: "FINANCE",
    label: "Finance",
    folder: "05_finance",
    dependencies: ["BRAND"],
    producedVentureStage: "BRAND_READY", // parallel-to-brand; see header note
    defaultReviewGate: false,
    providerRequired: false,
    tabOwner: "AuditTab",
  },
  {
    id: "PRODUCT_SPEC",
    label: "Product Spec",
    folder: "06_product",
    dependencies: ["BRAND"],
    producedVentureStage: "SPEC_READY",
    defaultReviewGate: false,
    providerRequired: false,
    tabOwner: "SpecTab",
  },
  {
    id: "WIREFRAME",
    label: "Screens",
    folder: "06_product/wireframes",
    dependencies: ["PRODUCT_SPEC"],
    producedVentureStage: "WIREFRAME_READY",
    defaultReviewGate: false,
    providerRequired: false,
    tabOwner: "ScreensTab",
  },
  {
    id: "HANDOFF",
    label: "Handoff",
    folder: "06_product/wireframes",
    dependencies: ["WIREFRAME"],
    producedVentureStage: "STITCH_READY", // legacy marker name; see header note
    defaultReviewGate: false,
    providerRequired: false,
    tabOwner: "ScreensTab",
  },
  {
    id: "BACKEND",
    label: "Backend",
    folder: "12_backend",
    dependencies: ["HANDOFF"],
    producedVentureStage: "BACKEND_READY",
    defaultReviewGate: false,
    providerRequired: false,
    tabOwner: "BackendTab",
  },
  {
    id: "AUDIT",
    label: "Audit",
    folder: "09_operate/audits",
    dependencies: ["BACKEND"],
    producedVentureStage: "AUDIT_READY",
    defaultReviewGate: true,
    providerRequired: false,
    tabOwner: "AuditTab",
  },
  {
    id: "BUILD",
    label: "Build",
    folder: "07_build",
    dependencies: ["HANDOFF", "BACKEND"],
    producedVentureStage: "BUILD_READY",
    defaultReviewGate: false,
    providerRequired: false,
    tabOwner: "AuditTab",
  },
  {
    id: "LAUNCH",
    label: "Launch",
    folder: "08_launch",
    dependencies: ["BUILD"],
    producedVentureStage: "LAUNCH_READY",
    defaultReviewGate: false,
    providerRequired: false,
    tabOwner: "AuditTab",
  },
  {
    id: "MEDIA",
    label: "Media",
    folder: "10_media",
    dependencies: ["LAUNCH"],
    producedVentureStage: "MEDIA_READY",
    defaultReviewGate: false,
    providerRequired: false,
    tabOwner: "MediaTab",
  },
  {
    id: "MEDIA_EDIT",
    label: "Media Edit",
    folder: "10_media/edits",
    dependencies: ["MEDIA"],
    producedVentureStage: "MEDIA_EDIT_READY",
    defaultReviewGate: false,
    providerRequired: false,
    tabOwner: "MediaTab",
  },
  {
    id: "CRM",
    label: "CRM",
    folder: "11_crm",
    dependencies: ["LAUNCH"],
    producedVentureStage: "CRM_READY",
    // CRM emits a pre-send review gate at runtime (autoSend=false) but
    // not as a static default — leave defaultReviewGate=false and let
    // the runner control it dynamically.
    defaultReviewGate: false,
    providerRequired: false,
    tabOwner: "CrmTab",
  },
  {
    id: "UK_SETUP",
    label: "UK Setup",
    folder: "04_uk_business",
    // UK_SETUP has no upstream-stage gate -- it can run independently
    // from the start. Lives near the end of the canonical iteration
    // order for UX reasons (post-launch admin), not data-flow reasons.
    dependencies: [],
    producedVentureStage: "UK_SETUP_READY",
    defaultReviewGate: false,
    providerRequired: false,
    tabOwner: "UkSetupTab",
  },
  {
    id: "HANDOFF_PACK",
    label: "Handoff Pack",
    folder: "13_handoff_pack",
    dependencies: ["BRAND", "PRODUCT_SPEC", "BUILD", "LAUNCH"],
    producedVentureStage: "HANDOFF_PACK_READY",
    defaultReviewGate: false,
    providerRequired: false,
    tabOwner: "HandoffPackTab",
  },
] as const;

/** Look up a single node by StageName. */
export function getStageGraphNode(name: StageName): StageGraphNode | undefined {
  return STAGE_GRAPH.find((n) => n.id === name);
}

/**
 * Derive a topological iteration order from STAGE_GRAPH.dependencies.
 * Ties (independent nodes) preserve STAGE_GRAPH's array order so the
 * output stays stable across versions.
 *
 * Returns the StageNames in an order where every node appears after
 * its declared dependencies. Throws on a cycle (which would be a graph
 * authoring bug).
 */
export function topologicalStageOrder(): StageName[] {
  const order: StageName[] = [];
  const remaining = new Set(STAGE_GRAPH.map((n) => n.id));
  const completed = new Set<StageName>();
  // Cap iterations to prevent infinite loops on graph authoring bugs.
  const maxPasses = STAGE_GRAPH.length + 1;
  for (let pass = 0; pass < maxPasses; pass++) {
    if (remaining.size === 0) return order;
    let advanced = false;
    for (const node of STAGE_GRAPH) {
      if (!remaining.has(node.id)) continue;
      const ready = node.dependencies.every((d) => completed.has(d));
      if (ready) {
        order.push(node.id);
        completed.add(node.id);
        remaining.delete(node.id);
        advanced = true;
      }
    }
    if (!advanced) {
      const stuck = Array.from(remaining).join(", ");
      throw new Error(
        `topologicalStageOrder: dependency cycle or missing dependency among [${stuck}]`,
      );
    }
  }
  return order;
}

/**
 * Reverse lookup: which stage(s) advance the venture to a given
 * VentureStage marker. Most markers have exactly one producer; the
 * BRAND_READY marker has two (BRAND and FINANCE) so the return type
 * is an array.
 */
export function stagesProducedByVentureStage(
  marker: VentureStageMarker,
): StageName[] {
  return STAGE_GRAPH.filter((n) => n.producedVentureStage === marker).map((n) => n.id);
}

/** Convenience: stages that ship with `defaultReviewGate=true`. */
export function defaultReviewGateStages(): StageName[] {
  return STAGE_GRAPH.filter((n) => n.defaultReviewGate).map((n) => n.id);
}

/** Convenience: stages that REQUIRE an LLM provider (no deterministic fallback). */
export function providerRequiredStages(): StageName[] {
  return STAGE_GRAPH.filter((n) => n.providerRequired).map((n) => n.id);
}
