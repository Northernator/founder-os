import * as fs from "node:fs";
import chokidar from "chokidar";
import { createLogger } from "@founder-os/logger";
import {
  safeParseBundle,
  type HandoffBundle,
} from "@founder-os/handoff-contract";
import { ventureHandoffPaths } from "@founder-os/workspace-core";

const log = createLogger("handoff-vscode:watch-inbox");

/**
 * Watch the venture inbox for new HandoffBundle JSON files.
 *
 * Implementation notes:
 *   - Uses **chokidar v4** (already in package.json deps). Chokidar handles
 *     Windows quirks that fs.watch gets wrong: subdirectory recursion,
 *     atomic-rename editors (VS Code, Tauri's writers), and missed events
 *     under WSL bind mounts.
 *   - `ignoreInitial: false` reports files already present when the watcher
 *     starts as `add` events. That's exactly what we want - if VS Code
 *     restarts while a bundle is queued, we process it on activate.
 *     extension.ts is responsible for deleting consumed bundles via
 *     `consumeInboxFile`, so stale files don't loop.
 *   - `awaitWriteFinish` debounces fires until the file size stops changing,
 *     so we don't read a half-written JSON.
 *   - We listen on both `add` and `change` events, de-duped via an in-memory
 *     seen-set keyed on "filePath@mtimeMs" so a single write doesn't fire
 *     twice (chokidar can emit add+change in close succession).
 *
 * Returns an unsubscribe function that closes the watcher.
 */
export function watchInbox(
  ventureRoot: string,
  onBundle: (bundle: HandoffBundle) => void | Promise<void>,
): () => void {
  const paths = ventureHandoffPaths(ventureRoot);
  fs.mkdirSync(paths.inbox, { recursive: true });

  log.info("Watching inbox (chokidar): " + paths.inbox);

  const seen = new Map<string, number>();

  const processFile = async (filePath: string): Promise<void> => {
    if (!filePath.endsWith(".json")) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return; // file vanished between event and stat
    }
    const key = filePath + "@" + stat.mtimeMs;
    if (seen.has(key)) return;
    seen.set(key, Date.now());
    pruneSeen(seen);

    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const parsed = safeParseBundle(raw);
      if (!parsed.success) {
        log.warn(
          "Invalid bundle at " + filePath + ": " + parsed.error.message,
        );
        return;
      }
      log.info("Picked up bundle " + parsed.data.runId + " from inbox");
      await onBundle(parsed.data);
    } catch (err) {
      log.warn(
        "Failed to process inbox file " + filePath + ": " + String(err),
      );
    }
  };

  const watcher = chokidar.watch(paths.inbox, {
    persistent: true,
    ignoreInitial: false,
    depth: 0,
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50,
    },
  });

  watcher.on("add",   (filePath) => { void processFile(filePath); });
  watcher.on("change", (filePath) => { void processFile(filePath); });
  watcher.on("error",  (err) => { log.warn("chokidar error: " + String(err)); });
  watcher.on("ready",  () => { log.info("chokidar ready on " + paths.inbox); });

  return () => {
    void watcher.close();
    seen.clear();
    log.info("Stopped watching inbox");
  };
}

function pruneSeen(seen: Map<string, number>): void {
  const now = Date.now();
  const TTL_MS = 60_000;
  for (const [key, when] of seen) {
    if (now - when > TTL_MS) seen.delete(key);
  }
  if (seen.size > 1000) {
    const drop = seen.size - 500;
    let i = 0;
    for (const key of seen.keys()) {
      if (i++ >= drop) break;
      seen.delete(key);
    }
  }
}
