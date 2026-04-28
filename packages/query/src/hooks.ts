import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryResult,
  type UseMutationResult,
} from "@tanstack/react-query";
import { queryKeys } from "./query-keys.js";
import type { Venture, VentureStage } from "@founder-os/domain";

// ──────────────────────────────────────────────
// Adapter interface — injected from the app layer
// ──────────────────────────────────────────────
export type VentureAdapter = {
  listVentures: () => Promise<Venture[]>;
  getVenture: (id: string) => Promise<Venture | null>;
  updateVentureStage: (id: string, stage: VentureStage) => Promise<void>;
};

let _adapter: VentureAdapter | null = null;

export function configureQueryAdapter(adapter: VentureAdapter): void {
  _adapter = adapter;
}

function requireAdapter(): VentureAdapter {
  if (!_adapter) throw new Error("Query adapter not configured — call configureQueryAdapter() at app startup");
  return _adapter;
}

// ──────────────────────────────────────────────
// Hooks
// ──────────────────────────────────────────────

export function useVentures(): UseQueryResult<Venture[]> {
  return useQuery({
    queryKey: queryKeys.ventures.all(),
    queryFn: () => requireAdapter().listVentures(),
    staleTime: 30_000,
  });
}

export function useVenture(id: string): UseQueryResult<Venture | null> {
  return useQuery({
    queryKey: queryKeys.ventures.detail(id),
    queryFn: () => requireAdapter().getVenture(id),
    staleTime: 15_000,
    enabled: !!id,
  });
}

export function useAdvanceStage(ventureId: string): UseMutationResult<void, Error, VentureStage> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (stage: VentureStage) =>
      requireAdapter().updateVentureStage(ventureId, stage),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.ventures.all() });
      qc.invalidateQueries({ queryKey: queryKeys.ventures.detail(ventureId) });
    },
  });
}
