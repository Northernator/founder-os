import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "@founder-os/logger";
import {
  HandoffBundle,
  HandoffResult,
  HandoffProgressEvent,
  safeParseBundle,
} from "@founder-os/handoff-contract";
import { ventureHandoffPaths } from "@founder-os/workspace-core";

const log = createLogger("handoff-desktop:inbox-outbox");

/** Write a HandoffBundle JSON to the venture's inbox dir */
export function writeInbox(bundle: HandoffBundle, ventureRoot: string): string {
  const paths = ventureHandoffPaths(ventureRoot);
  fs.mkdirSync(paths.inbox, { recursive: true });
  const filePath = path.join(paths.inbox, `${bundle.runId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2), "utf-8");
  log.info(`Wrote bundle ${bundle.runId} → inbox: ${filePath}`);
  return filePath;
}

/** Watch the outbox dir for result files; calls onResult for each */
export function watchOutbox(
  ventureRoot: string,
  onResult: (result: HandoffResult) => void,
  onProgress?: (evt: HandoffProgressEvent) => void
): () => void {
  const paths = ventureHandoffPaths(ventureRoot);
  fs.mkdirSync(paths.outbox, { recursive: true });
  fs.mkdirSync(paths.progress, { recursive: true });

  const processFile = (filePath: string) => {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      // Distinguish result from progress by shape
      if ("completedAt" in raw) {
        onResult(raw as HandoffResult);
        // Clean up after consuming
        fs.unlinkSync(filePath);
      } else if ("emittedAt" in raw && onProgress) {
        onProgress(raw as HandoffProgressEvent);
      }
    } catch (err) {
      log.warn(`Could not parse outbox file ${filePath}: ${err}`);
    }
  };

  // Poll every 2s (Tauri doesn't ship chokidar — use polling)
  const seenFiles = new Set<string>();
  const interval = setInterval(() => {
    for (const dir of [paths.outbox, paths.progress]) {
      if (!fs.existsSync(dir)) continue;
      for (const fname of fs.readdirSync(dir)) {
        if (!fname.endsWith(".json")) continue;
        const fp = path.join(dir, fname);
        if (!seenFiles.has(fp)) {
          seenFiles.add(fp);
          processFile(fp);
        }
      }
    }
  }, 2000);

  log.info(`Watching outbox: ${paths.outbox}`);

  return () => {
    clearInterval(interval);
    log.info("Stopped watching outbox");
  };
}

/** Read and delete all bundles from the inbox (used by VS Code side for pickup) */
export function drainInbox(ventureRoot: string): HandoffBundle[] {
  const paths = ventureHandoffPaths(ventureRoot);
  if (!fs.existsSync(paths.inbox)) return [];

  const bundles: HandoffBundle[] = [];
  for (const fname of fs.readdirSync(paths.inbox)) {
    if (!fname.endsWith(".json")) continue;
    const fp = path.join(paths.inbox, fname);
    try {
      const raw = JSON.parse(fs.readFileSync(fp, "utf-8"));
      const result = safeParseBundle(raw);
      if (result.success) {
        bundles.push(result.data);
        fs.unlinkSync(fp);
      } else {
        log.warn(`Invalid bundle at ${fp}: ${result.error}`);
      }
    } catch (err) {
      log.warn(`Could not parse inbox file ${fp}: ${err}`);
    }
  }
  return bundles;
}

/** Write a HandoffResult back to the outbox */
export function writeOutbox(result: HandoffResult, ventureRoot: string): string {
  const paths = ventureHandoffPaths(ventureRoot);
  fs.mkdirSync(paths.outbox, { recursive: true });
  const filePath = path.join(paths.outbox, `${result.runId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2), "utf-8");
  log.info(`Wrote result ${result.runId} → outbox: ${filePath}`);
  return filePath;
}

/** Write a progress event to the progress dir */
export function writeProgress(evt: HandoffProgressEvent, ventureRoot: string): void {
  const paths = ventureHandoffPaths(ventureRoot);
  fs.mkdirSync(paths.progress, { recursive: true });
  const filePath = path.join(paths.progress, `${evt.runId}_${Date.now()}.json`);
  fs.writeFileSync(filePath, JSON.stringify(evt, null, 2), "utf-8");
}
