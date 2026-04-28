import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "@founder-os/logger";
import type { HandoffResult, HandoffProgressEvent } from "@founder-os/handoff-contract";
import { ventureHandoffPaths } from "@founder-os/workspace-core";

const log = createLogger("handoff-vscode:write-result");

/** Write a HandoffResult to the venture outbox so the desktop picks it up */
export function writeResult(result: HandoffResult, ventureRoot: string): string {
  const paths = ventureHandoffPaths(ventureRoot);
  fs.mkdirSync(paths.outbox, { recursive: true });
  const filePath = path.join(paths.outbox, `${result.runId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2), "utf-8");
  log.info(`Wrote result ${result.runId} → ${filePath}`);
  return filePath;
}

/** Emit a progress event to the progress dir */
export function writeProgress(evt: HandoffProgressEvent, ventureRoot: string): void {
  const paths = ventureHandoffPaths(ventureRoot);
  fs.mkdirSync(paths.progress, { recursive: true });
  const ts = Date.now();
  const filePath = path.join(paths.progress, `${evt.runId}_${ts}.json`);
  fs.writeFileSync(filePath, JSON.stringify(evt, null, 2), "utf-8");
}

/** Build a success result */
export function makeSuccessResult(
  bundle: { runId: string; ventureId: string },
  producedArtifacts: Array<{ artifactId: string; path: string; type: string }>,
  summary: string
): HandoffResult {
  return {
    runId: bundle.runId,
    ventureId: bundle.ventureId,
    status: "success",
    producedArtifacts,
    summary,
    completedAt: new Date().toISOString(),
    schemaVersion: 1,
  };
}

/** Build a failure result */
export function makeFailureResult(
  bundle: { runId: string; ventureId: string },
  error: string
): HandoffResult {
  return {
    runId: bundle.runId,
    ventureId: bundle.ventureId,
    status: "failed",
    producedArtifacts: [],
    error,
    completedAt: new Date().toISOString(),
    schemaVersion: 1,
  };
}
