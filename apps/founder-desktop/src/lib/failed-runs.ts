/**
 * Desktop-side failed-run IO.
 *
 * The orchestrator in @founder-os/stage-runners writes failed-run
 * entries to .founder/state/failed-runs.json (a slim index) alongside
 * a per-run StageRunResult dump under .founder/handoffs/failed/. The
 * desktop reads + mutates the index directly through tauriFs so the
 * UI can list "retry needed" entries without instantiating a full
 * PipelineOrchestrator.
 *
 * Mirror of review-gates.ts. Same single-writer concurrency assumption
 * holds -- mutations only happen on user click + sequential stage runs.
 *
 * Reading the per-run dump (full StageRunResult with logs and
 * artifactsCreated) is a separate read against entry.resultPath via
 * tauriFs.readFile -- intentionally not bundled here since most UI
 * surfaces only need the index data.
 */
import type { FailedRunEntry, StageName } from "@founder-os/domain";
import { getFailedRunsIndexPath } from "@founder-os/workspace-core";
import { tauriFs } from "./pipeline-fs.js";

export async function loadFailedRuns(ventureRoot: string): Promise<FailedRunEntry[]> {
  const path = getFailedRunsIndexPath(ventureRoot);
  if (!(await tauriFs.exists(path))) return [];
  try {
    const raw = await tauriFs.readFile(path);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as FailedRunEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * Most recent failed run for a stage, or null. Useful when a tab
 * wants to surface a single retry CTA: pick the latest failure for
 * that stage, ignore anything older. "Most recent" = latest failedAt.
 */
export async function findLatestFailedRunForStage(
  ventureRoot: string,
  stageName: StageName
): Promise<FailedRunEntry | null> {
  const all = await loadFailedRuns(ventureRoot);
  const matches = all
    .filter((e) => e.stageName === stageName)
    .sort((a, b) => (a.failedAt < b.failedAt ? 1 : -1));
  return matches[0] ?? null;
}

/**
 * Remove all failed-run entries for a stage from the index. Called
 * after a successful retry clears the earlier failure (the orchestrator
 * does this server-side too on a successful runStage, but the desktop
 * may want to dismiss without re-running).
 *
 * If runId is provided, removes only that specific entry.
 */
export async function markFailedRunResolved(
  ventureRoot: string,
  stageName: StageName,
  runId?: string
): Promise<void> {
  const all = await loadFailedRuns(ventureRoot);
  const filtered = runId
    ? all.filter((e) => !(e.stageName === stageName && e.runId === runId))
    : all.filter((e) => e.stageName !== stageName);
  if (filtered.length === all.length) return; // no-op
  const path = getFailedRunsIndexPath(ventureRoot);
  await tauriFs.writeFile(path, `${JSON.stringify(filtered, null, 2)}\n`);
}

/**
 * Read the per-run StageRunResult dump pointed to by the index entry.
 * Returns null if the dump file is missing or unreadable -- callers
 * should treat that as "details unavailable, fall back to index data".
 */
export async function loadFailedRunResult(resultPath: string): Promise<unknown | null> {
  if (!(await tauriFs.exists(resultPath))) return null;
  try {
    return JSON.parse(await tauriFs.readFile(resultPath));
  } catch {
    return null;
  }
}
