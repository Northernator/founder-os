import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { RunPlan } from "@founder-os/pipeline-core";

export type PipelineStore = {
  // State
  activePlan: RunPlan | null;
  planHistory: RunPlan[];
  isRunning: boolean;

  // Actions
  setActivePlan: (plan: RunPlan | null) => void;
  updateActivePlan: (plan: RunPlan) => void;
  setRunning: (running: boolean) => void;
  completePlan: () => void;
};

export const usePipelineStore = create<PipelineStore>()(
  subscribeWithSelector((set, get) => ({
    activePlan: null,
    planHistory: [],
    isRunning: false,

    setActivePlan: (plan) => set({ activePlan: plan, isRunning: !!plan }),

    updateActivePlan: (plan) => set({ activePlan: plan }),

    setRunning: (isRunning) => set({ isRunning }),

    completePlan: () => {
      const { activePlan, planHistory } = get();
      if (!activePlan) return;
      set({
        planHistory: [...planHistory, activePlan],
        activePlan: null,
        isRunning: false,
      });
    },
  }))
);
