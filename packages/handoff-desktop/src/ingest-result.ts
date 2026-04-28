import { createLogger } from "@founder-os/logger";
import type { HandoffResult } from "@founder-os/handoff-contract";

const log = createLogger("handoff-desktop:ingest-result");

export type IngestResultCallbacks = {
  onSuccess?: (result: HandoffResult) => void | Promise<void>;
  onFailure?: (result: HandoffResult) => void | Promise<void>;
  onArtifacts?: (artifactIds: string[]) => void | Promise<void>;
};

/**
 * Process an incoming HandoffResult from the VS Code extension.
 * Calls the appropriate callbacks and logs the outcome.
 */
export async function ingestResult(
  result: HandoffResult,
  callbacks: IngestResultCallbacks = {}
): Promise<void> {
  log.info(`Ingesting result for run ${result.runId} — status: ${result.status}`);

  if (result.status === "success") {
    if (result.producedArtifacts.length > 0 && callbacks.onArtifacts) {
      await callbacks.onArtifacts(result.producedArtifacts.map((a) => a.artifactId));
    }
    if (callbacks.onSuccess) {
      await callbacks.onSuccess(result);
    }
    log.info(`Run ${result.runId} completed successfully — ${result.producedArtifacts.length} artifacts produced`);
  } else if (result.status === "failed") {
    log.warn(`Run ${result.runId} failed: ${result.error ?? "unknown error"}`);
    if (callbacks.onFailure) {
      await callbacks.onFailure(result);
    }
  } else {
    log.info(`Run ${result.runId} completed with status: ${result.status}`);
  }
}
