import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "@founder-os/logger";
import type { HandoffBundle } from "@founder-os/handoff-contract";
import { writeProgress } from "./write-result.js";

const log = createLogger("handoff-vscode:accept-bundle");

export type AcceptedBundle = {
  bundle: HandoffBundle;
  workspaceRoot: string;
  acceptedAt: string;
};

/**
 * Accept a bundle: validate it, emit an "accepted" progress event,
 * and return it ready for the runner to process.
 */
export function acceptBundle(bundle: HandoffBundle): AcceptedBundle {
  log.info(`Accepting bundle ${bundle.runId} (type=${bundle.type})`);

  // Emit accepted progress event
  writeProgress(
    {
      runId: bundle.runId,
      status: "accepted",
      message: `Bundle ${bundle.runId} accepted by VS Code extension`,
      percentComplete: 0,
      emittedAt: new Date().toISOString(),
    },
    bundle.ventureRoot
  );

  return {
    bundle,
    workspaceRoot: bundle.ventureRoot,
    acceptedAt: new Date().toISOString(),
  };
}

/**
 * Delete the bundle file from the inbox after acceptance.
 */
export function consumeInboxFile(bundleRunId: string, ventureRoot: string): void {
  const inboxDir = path.join(ventureRoot, ".founder", "handoff", "inbox");
  const filePath = path.join(inboxDir, `${bundleRunId}.json`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    log.info(`Consumed inbox file: ${filePath}`);
  }
}
