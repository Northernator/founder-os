/** Centralised query key factory — prevents key collisions and typos */
export const queryKeys = {
  ventures: {
    all: () => ["ventures"] as const,
    detail: (id: string) => ["ventures", id] as const,
    artifacts: (id: string) => ["ventures", id, "artifacts"] as const,
    runs: (id: string) => ["ventures", id, "runs"] as const,
    auditFindings: (id: string) => ["ventures", id, "audit-findings"] as const,
  },
  handoffs: {
    all: () => ["handoffs"] as const,
    detail: (runId: string) => ["handoffs", runId] as const,
  },
  pipeline: {
    plan: (runId: string) => ["pipeline", "plan", runId] as const,
  },
} as const;
