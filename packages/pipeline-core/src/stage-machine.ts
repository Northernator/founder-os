import { VentureStage, VENTURE_STAGE_ORDER } from "@founder-os/domain";

export type StageTransitionGuard = (fromStage: VentureStage, toStage: VentureStage) => boolean | string;

export interface StageTransition {
  from: VentureStage;
  to: VentureStage;
  label: string;
}

/** All valid forward transitions in order */
export const STAGE_TRANSITIONS: StageTransition[] = VENTURE_STAGE_ORDER.slice(0, -1).map(
  (from, i) => ({
    from,
    to: VENTURE_STAGE_ORDER[i + 1] as VentureStage,
    label: `${from} → ${VENTURE_STAGE_ORDER[i + 1]}`,
  })
);

export function canAdvance(
  currentStage: VentureStage,
  guards: StageTransitionGuard[] = []
): true | string[] {
  const idx = VENTURE_STAGE_ORDER.indexOf(currentStage);
  if (idx === -1) return ["Unknown stage"];
  if (idx >= VENTURE_STAGE_ORDER.length - 1) return ["Already at final stage"];
  const nextStage = VENTURE_STAGE_ORDER[idx + 1] as VentureStage;

  const errors: string[] = [];
  for (const guard of guards) {
    const result = guard(currentStage, nextStage);
    if (typeof result === "string") errors.push(result);
    else if (result === false) errors.push(`Guard blocked transition ${currentStage} → ${nextStage}`);
  }
  return errors.length === 0 ? true : errors;
}

export function nextStage(current: VentureStage): VentureStage | null {
  const idx = VENTURE_STAGE_ORDER.indexOf(current);
  if (idx === -1 || idx >= VENTURE_STAGE_ORDER.length - 1) return null;
  return VENTURE_STAGE_ORDER[idx + 1] as VentureStage;
}

export function prevStage(current: VentureStage): VentureStage | null {
  const idx = VENTURE_STAGE_ORDER.indexOf(current);
  if (idx <= 0) return null;
  return VENTURE_STAGE_ORDER[idx - 1] as VentureStage;
}

export function stageIndex(stage: VentureStage): number {
  return VENTURE_STAGE_ORDER.indexOf(stage);
}

export function isStageAtLeast(current: VentureStage, minimum: VentureStage): boolean {
  return stageIndex(current) >= stageIndex(minimum);
}
