/**
 * Typed errors for the orchestrator.
 *
 * Each phase has its own error class so a caller (stage-runners,
 * gatherDeepResearch helper) can distinguish "planner failed" from
 * "all workers failed" from "synthesiser failed" without sniffing
 * error messages.
 */

export class PlannerError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(`planner: ${message}`);
    this.name = "PlannerError";
    this.cause = cause;
  }
}

export class AllWorkersFailedError extends Error {
  /**
   * Map of channel name -> the error that channel returned. Useful for
   * surfacing per-channel diagnostics in the UI without re-running.
   */
  readonly failures: ReadonlyMap<string, unknown>;
  constructor(failures: ReadonlyMap<string, unknown>) {
    const channels = [...failures.keys()].join(", ");
    super(`all workers failed across channels: ${channels}`);
    this.name = "AllWorkersFailedError";
    this.failures = failures;
  }
}

export class CrossReferenceError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(`cross-reference: ${message}`);
    this.name = "CrossReferenceError";
    this.cause = cause;
  }
}

export class SynthesiserError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(`synthesiser: ${message}`);
    this.name = "SynthesiserError";
    this.cause = cause;
  }
}
