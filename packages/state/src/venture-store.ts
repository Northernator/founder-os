import type { Venture, VentureStage } from "@founder-os/domain";
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

export type VentureStore = {
  // State
  ventures: Venture[];
  activeVentureId: string | null;
  isLoading: boolean;
  error: string | null;

  // Computed (derived)
  activeVenture: () => Venture | null;

  // Actions
  setVentures: (ventures: Venture[]) => void;
  addVenture: (venture: Venture) => void;
  removeVenture: (ventureId: string) => void;
  setActiveVenture: (id: string | null) => void;
  updateVentureStage: (ventureId: string, stage: VentureStage) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
};

export const useVentureStore = create<VentureStore>()(
  subscribeWithSelector((set, get) => ({
    ventures: [],
    activeVentureId: null,
    isLoading: false,
    error: null,

    activeVenture: () => {
      const { ventures, activeVentureId } = get();
      return ventures.find((v) => v.id === activeVentureId) ?? null;
    },

    setVentures: (ventures) => set({ ventures }),

    addVenture: (venture) =>
      set((state) => ({
        ventures: state.ventures.some((v) => v.id === venture.id)
          ? state.ventures
          : [...state.ventures, venture],
      })),

    removeVenture: (ventureId) =>
      set((state) => ({
        ventures: state.ventures.filter((v) => v.id !== ventureId),
        // If we just deleted the active one, drop the selection so the
        // dashboard falls back to the welcome screen.
        activeVentureId: state.activeVentureId === ventureId ? null : state.activeVentureId,
      })),

    setActiveVenture: (id) => set({ activeVentureId: id }),

    updateVentureStage: (ventureId, stage) =>
      set((state) => ({
        ventures: state.ventures.map((v) =>
          v.id === ventureId ? { ...v, stage, updatedAt: new Date().toISOString() } : v
        ),
      })),

    setLoading: (isLoading) => set({ isLoading }),

    setError: (error) => set({ error }),
  }))
);
