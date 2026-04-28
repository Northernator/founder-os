import { type VentureStage, VentureStageSchema } from "@founder-os/domain";
import { z } from "zod";

export const RunStepStatusSchema = z.enum(["pending", "running", "done", "skipped", "failed"]);
export type RunStepStatus = z.infer<typeof RunStepStatusSchema>;

export const RunStepSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  status: RunStepStatusSchema.default("pending"),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
  producedArtifactIds: z.array(z.string()).default([]),
});
export type RunStep = z.infer<typeof RunStepSchema>;

export const RunPlanSchema = z.object({
  runId: z.string(),
  ventureId: z.string(),
  targetStage: VentureStageSchema,
  createdAt: z.string(),
  steps: z.array(RunStepSchema),
});
export type RunPlan = z.infer<typeof RunPlanSchema>;

export function createRunPlan(opts: {
  runId: string;
  ventureId: string;
  targetStage: VentureStage;
  steps: Omit<RunStep, "status" | "producedArtifactIds">[];
}): RunPlan {
  return RunPlanSchema.parse({
    runId: opts.runId,
    ventureId: opts.ventureId,
    targetStage: opts.targetStage,
    createdAt: new Date().toISOString(),
    steps: opts.steps.map((s) => ({
      ...s,
      status: "pending",
      producedArtifactIds: [],
    })),
  });
}

export function updateStep(plan: RunPlan, stepId: string, patch: Partial<RunStep>): RunPlan {
  return {
    ...plan,
    steps: plan.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)),
  };
}

export function planProgress(plan: RunPlan): {
  total: number;
  done: number;
  failed: number;
  percentComplete: number;
} {
  const total = plan.steps.length;
  const done = plan.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const failed = plan.steps.filter((s) => s.status === "failed").length;
  return {
    total,
    done,
    failed,
    percentComplete: total === 0 ? 0 : Math.round((done / total) * 100),
  };
}
