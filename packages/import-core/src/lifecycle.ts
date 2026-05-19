/**
 * Pure functions for ImportJob lifecycle. The runner (slice 8) wires
 * SQLite / fs side effects around these; here we keep the state machine
 * deterministic and unit-testable.
 */

import type { ImportJob, ImportJobStatus } from "@founder-os/vault-contract";

/**
 * Allowed transitions. Anything not listed throws so a bug fails loudly
 * instead of leaving a job stuck in an undefined state.
 */
const TRANSITIONS: Record<ImportJobStatus, ImportJobStatus[]> = {
  queued: ["processing", "cancelled", "failed"],
  processing: ["needs_review", "failed", "cancelled"],
  needs_review: ["committed", "cancelled", "failed"],
  committed: [],
  failed: [],
  cancelled: [],
};

export class IllegalImportJobTransitionError extends Error {
  constructor(public readonly from: ImportJobStatus, public readonly to: ImportJobStatus) {
    super(`Illegal import-job transition: ${from} -> ${to}`);
    this.name = "IllegalImportJobTransitionError";
  }
}

export function isTerminalStatus(status: ImportJobStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export function canTransition(from: ImportJobStatus, to: ImportJobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ImportJobStatus, to: ImportJobStatus): void {
  if (!canTransition(from, to)) {
    throw new IllegalImportJobTransitionError(from, to);
  }
}

export interface AdvanceJobInput {
  job: ImportJob;
  to: ImportJobStatus;
  now: string;
  errorMessage?: string;
}

export function advanceJob(input: AdvanceJobInput): ImportJob {
  assertTransition(input.job.status, input.to);
  return {
    ...input.job,
    status: input.to,
    errorMessage: input.errorMessage ?? input.job.errorMessage,
    updatedAt: input.now,
  };
}

/**
 * Bookkeeping increment for per-file outcomes. Failed files never block
 * job-level progress -- they bump failedCount and the job continues.
 */
export interface RecordFileOutcomeInput {
  job: ImportJob;
  outcome: "succeeded" | "failed" | "warned";
  now: string;
}

export function recordFileOutcome(input: RecordFileOutcomeInput): ImportJob {
  const next: ImportJob = { ...input.job, updatedAt: input.now };
  switch (input.outcome) {
    case "succeeded":
      next.processedCount = input.job.processedCount + 1;
      break;
    case "failed":
      next.failedCount = input.job.failedCount + 1;
      next.processedCount = input.job.processedCount + 1;
      break;
    case "warned":
      next.warningCount = input.job.warningCount + 1;
      next.processedCount = input.job.processedCount + 1;
      break;
  }
  return next;
}
