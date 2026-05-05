/**
 * Desktop-side review-gate IO.
 *
 * The orchestrator in @founder-os/stage-runners writes review gates to
 * .founder/state/review-gates.json via the injected Filesystem port.
 * The desktop reads + mutates that file directly through the Tauri FS
 * adapter for the small surface UI components actually need: list
 * pending gates, find one for a stage, approve, reject.
 *
 * Why not call PipelineOrchestrator directly: orchestrator construction
 * needs a full VentureManifest, and the AdvanceConfirmModal already has
 * the venture root + stage in hand. A 60-line helper that reuses the
 * canonical paths from @founder-os/workspace-core is cheaper than
 * threading the manifest into every UI surface that touches gates.
 *
 * Concurrency model: stage runs are sequential per venture, and gate
 * mutations only happen on user click. The read-merge-write pattern is
 * fine for now -- if multiple windows ever race, we move to the
 * orchestrator path with a proper lock.
 */
import type { ReviewGate, StageName, StageProgress } from "@founder-os/domain";
import { getReviewGatesPath, getStageProgressPath } from "@founder-os/workspace-core";
import { tauriFs } from "./pipeline-fs.js";

export async function loadReviewGates(ventureRoot: string): Promise<ReviewGate[]> {
  const path = getReviewGatesPath(ventureRoot);
  if (!(await tauriFs.exists(path))) return [];
  try {
    const raw = await tauriFs.readFile(path);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ReviewGate[]) : [];
  } catch {
    // Malformed file -- treat as empty so the UI doesn't get stuck. The
    // file gets rewritten the next time a runner emits a gate.
    return [];
  }
}

/**
 * Return the most recent pending gate for the given stage, or null.
 * "Most recent" = latest createdAt. There should normally be at most
 * one pending gate per stage, but if two co-exist (e.g. user re-ran
 * BRAND mid-review) the newer one wins -- the older one is stale.
 */
export async function findPendingReviewGateForStage(
  ventureRoot: string,
  stageName: StageName
): Promise<ReviewGate | null> {
  const gates = await loadReviewGates(ventureRoot);
  const pending = gates
    .filter((g) => g.status === "pending" && g.stageName === stageName)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return pending[0] ?? null;
}

export async function approveReviewGate(
  ventureRoot: string,
  gateId: string,
  approvedBy: string,
  feedback?: string
): Promise<void> {
  // Capture the stageName before mutation -- mutateGate's apply
  // closure runs against the in-memory copy and we need this to
  // mirror the orchestrator's advanceProgress side-effect after.
  let stageName: StageName | null = null;
  let alreadyApproved = false;
  await mutateGate(ventureRoot, gateId, (g) => {
    stageName = g.stageName;
    if (g.status === "approved") {
      alreadyApproved = true;
      return; // idempotent: don't double-write stage-progress
    }
    g.status = "approved";
    g.approvedBy = approvedBy;
    g.approvedAt = new Date().toISOString();
    if (feedback !== undefined) g.feedback = feedback;
  });
  // Mirror orchestrator.approveReviewGate: a fresh approval advances
  // stage-progress.json so future stage-runners see the prior stage
  // as complete and short-circuit on idempotency. Skipped on a
  // double-approve since the file would already reflect it.
  if (stageName !== null && !alreadyApproved) {
    await markStageCompleteInProgress(ventureRoot, stageName);
  }
}

export async function rejectReviewGate(
  ventureRoot: string,
  gateId: string,
  rejectedBy: string,
  feedback?: string
): Promise<void> {
  await mutateGate(ventureRoot, gateId, (g) => {
    if (g.status === "rejected") return; // idempotent
    g.status = "rejected";
    g.approvedBy = rejectedBy;
    g.approvedAt = new Date().toISOString();
    if (feedback !== undefined) g.feedback = feedback;
  });
}

async function mutateGate(
  ventureRoot: string,
  gateId: string,
  apply: (g: ReviewGate) => void
): Promise<void> {
  const gates = await loadReviewGates(ventureRoot);
  const gate = gates.find((g) => g.gateId === gateId);
  if (!gate) {
    throw new Error(`review gate not found: ${gateId}`);
  }
  apply(gate);
  const path = getReviewGatesPath(ventureRoot);
  await tauriFs.writeFile(path, `${JSON.stringify(gates, null, 2)}\n`);
}

/**
 * Update .founder/state/stage-progress.json to mark `stageName` as
 * complete and set it as currentStage. Mirrors the orchestrator's
 * private advanceProgress() so the desktop's approve flow keeps the
 * file in sync without needing to construct a PipelineOrchestrator
 * (which requires a full VentureManifest).
 *
 * Idempotent: if stageName is already in completedStages, the file
 * still gets re-written with a fresh updatedAt -- harmless. The
 * orchestrator's own advanceProgress has the same shape.
 *
 * Concurrency: see the file-header note. Stage runs are sequential
 * per venture and gate approvals only fire on user click, so the
 * read-merge-write pattern is fine.
 */
export async function markStageCompleteInProgress(
  ventureRoot: string,
  stageName: StageName
): Promise<void> {
  const path = getStageProgressPath(ventureRoot);
  const now = new Date().toISOString();
  let existing: StageProgress | null = null;
  if (await tauriFs.exists(path)) {
    try {
      const raw = await tauriFs.readFile(path);
      existing = JSON.parse(raw) as StageProgress;
    } catch {
      // Malformed file -- treat as if absent. The fresh write below
      // overwrites it cleanly.
      existing = null;
    }
  }
  const startedAt = existing?.startedAt ?? now;
  const previous = existing?.completedStages ?? [];
  const completedStages = previous.includes(stageName) ? previous : [...previous, stageName];
  const next: StageProgress = {
    currentStage: stageName,
    completedStages,
    startedAt,
    updatedAt: now,
  };
  await tauriFs.writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
}
