/**
 * HandoffDispatcher - routes a HandoffBundle to the right runner based on
 * `bundle.type`. Pure routing: the actual runner implementations live in
 * the consumer (apps/founder-cowork) and are injected via DI so this
 * package stays free of vscode/agent-runner deps.
 */

import type {
  HandoffBundle,
  HandoffProgressEvent,
  HandoffRequestType,
  HandoffResult,
} from "@founder-os/handoff-contract";

export type ProgressCallback = (evt: HandoffProgressEvent) => void;

export interface HandoffRunnerContext {
  ventureRoot: string;
  /** Claude CLI binary name or absolute path. Default "claude" (must be on PATH). */
  claudeBinary: string;
  onProgress: ProgressCallback;
}

export type HandoffRunnerFn = (
  bundle: HandoffBundle,
  ctx: HandoffRunnerContext
) => Promise<HandoffResult>;

export type HandoffRunnerMap = Record<HandoffRequestType, HandoffRunnerFn>;

/**
 * Look up the runner for this bundle's type and invoke it. Throws a
 * descriptive error if no runner is registered for the type (the dispatcher
 * doesn't fall back to BUILD_FROM_BRIEF anymore - bundle.type drives
 * everything).
 */
export async function dispatchBundle(
  bundle: HandoffBundle,
  ctx: HandoffRunnerContext,
  runners: HandoffRunnerMap
): Promise<HandoffResult> {
  const runner = runners[bundle.type];
  if (!runner) {
    throw new Error("HandoffDispatcher: no runner registered for bundle.type=" + bundle.type);
  }
  return runner(bundle, ctx);
}
