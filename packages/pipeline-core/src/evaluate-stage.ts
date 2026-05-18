import type { VentureStage } from "@founder-os/domain";
import type { ArtifactRef } from "@founder-os/domain";

export type StageRequirement = {
  stage: VentureStage;
  requiredArtifactTypes: string[];
  description: string;
};

/** The artifact types required before a stage can be considered complete */
export const STAGE_REQUIREMENTS: StageRequirement[] = [
  {
    stage: "IDEA",
    requiredArtifactTypes: ["venture_manifest"],
    description: "A venture manifest must exist",
  },
  {
    stage: "RESEARCHED",
    requiredArtifactTypes: ["market_research"],
    description: "Market research artifact must exist",
  },
  {
    stage: "VALIDATED",
    requiredArtifactTypes: ["validation_report"],
    description: "Validation report must exist",
  },
  {
    stage: "BRAND_READY",
    requiredArtifactTypes: ["brand_brief", "logo_pack"],
    description: "Brand brief and logo pack must exist",
  },
  {
    stage: "SPEC_READY",
    requiredArtifactTypes: ["product_spec"],
    description: "Product spec must exist",
  },
  {
    stage: "WIREFRAME_READY",
    requiredArtifactTypes: ["wireframe_pack"],
    description: "Wireframe pack must exist",
  },
  {
    stage: "STITCH_READY",
    requiredArtifactTypes: ["stitch_export"],
    description: "Stitch export must exist",
  },
  {
    stage: "BUILD_READY",
    requiredArtifactTypes: ["build_handoff"],
    description: "Build handoff bundle must exist",
  },
  {
    stage: "AUDIT_READY",
    requiredArtifactTypes: ["audit_summary"],
    description: "Audit summary must exist",
  },
  {
    stage: "LAUNCH_READY",
    requiredArtifactTypes: ["launch_checklist"],
    description: "Launch checklist must exist",
  },
  {
    stage: "UK_SETUP_READY",
    requiredArtifactTypes: ["company_setup_checklist"],
    description: "UK company setup checklist must exist",
  },
  {
    stage: "LIVE",
    requiredArtifactTypes: [],
    description: "No additional artifacts required — venture is live",
  },
];

export type StageEvaluation = {
  stage: VentureStage;
  complete: boolean;
  missingTypes: string[];
  presentTypes: string[];
};

export function evaluateStageCompletion(
  stage: VentureStage,
  availableArtifacts: ArtifactRef[]
): StageEvaluation {
  const req = STAGE_REQUIREMENTS.find((r) => r.stage === stage);
  if (!req) {
    return { stage, complete: false, missingTypes: [], presentTypes: [] };
  }

  const availableTypes = new Set(availableArtifacts.map((a) => a.type));
  const missingTypes = req.requiredArtifactTypes.filter((t) => !availableTypes.has(t));
  const presentTypes = req.requiredArtifactTypes.filter((t) => availableTypes.has(t));

  return {
    stage,
    complete: missingTypes.length === 0,
    missingTypes,
    presentTypes,
  };
}

export function evaluateAllStages(artifacts: ArtifactRef[]): Map<VentureStage, StageEvaluation> {
  const results = new Map<VentureStage, StageEvaluation>();
  for (const req of STAGE_REQUIREMENTS) {
    results.set(req.stage, evaluateStageCompletion(req.stage, artifacts));
  }
  return results;
}

export function highestCompleteStage(artifacts: ArtifactRef[]): VentureStage {
  const evals = evaluateAllStages(artifacts);
  let highest: VentureStage = "IDEA";
  for (const [stage, ev] of evals) {
    if (ev.complete) highest = stage;
  }
  return highest;
}
