/**
 * Canonical path rules for every venture workspace.
 * All file IO adapters (workspace-tauri, workspace-node) MUST use these helpers
 * and must NEVER hard-code path strings.
 */

function join(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

// --- Top-level venture paths ---
export function getFounderRoot(ventureRoot: string): string {
  return `${ventureRoot}/.founder`;
}

export function getVentureManifestPath(ventureRoot: string): string {
  return `${ventureRoot}/venture.yaml`;
}

// --- .founder/ subpaths ---
export function getStateRoot(ventureRoot: string): string {
  return join(getFounderRoot(ventureRoot), "state");
}

export function getArtifactsIndexPath(ventureRoot: string): string {
  return join(getFounderRoot(ventureRoot), "artifacts", "index.json");
}

export function getChatsRoot(ventureRoot: string): string {
  return join(getFounderRoot(ventureRoot), "chats");
}

export function getLogsRoot(ventureRoot: string): string {
  return join(getFounderRoot(ventureRoot), "logs");
}

// --- Stage-runner state paths (slice 1 of stage-runners feature) ---
// These files are written by the orchestrator + read by the desktop app.
// The IO is performed via the per-environment Filesystem port (workspace-node
// or workspace-tauri), this module only exposes the canonical paths.

/** .founder/state/stage-progress.json — current/completed StageName tracking. */
export function getStageProgressPath(ventureRoot: string): string {
  return join(getStateRoot(ventureRoot), "stage-progress.json");
}

/** .founder/state/review-gates.json — pending/approved review gates. */
export function getReviewGatesPath(ventureRoot: string): string {
  return join(getStateRoot(ventureRoot), "review-gates.json");
}

/**
 * .founder/state/failed-runs.json — queryable index of failed
 * StageRunResults. Each entry points to a per-run dump under
 * .founder/handoffs/failed/ via resultPath. Slice 5 of stage-runners.
 */
export function getFailedRunsIndexPath(ventureRoot: string): string {
  return join(getStateRoot(ventureRoot), "failed-runs.json");
}

/**
 * .founder/logs/{stageName}-{runId}.jsonl — append-only structured run log.
 * One file per (stage, run) pair so failed runs keep their own trace.
 */
export function getStageRunLogPath(ventureRoot: string, stageName: string, runId: string): string {
  return join(getLogsRoot(ventureRoot), `${stageName}-${runId}.jsonl`);
}

/**
 * .founder/handoffs/failed/{stageName}-{runId}.result.json — full
 * StageRunResult JSON dropped here when a stage fails. Resume/retry
 * (slice 5) will read these to surface a "retry" action in the desktop UI.
 */
export function getFailedStageResultPath(
  ventureRoot: string,
  stageName: string,
  runId: string
): string {
  return join(getHandoffFailedPath(ventureRoot), `${stageName}-${runId}.result.json`);
}

// --- Handoff paths ---
export function getHandoffsRoot(ventureRoot: string): string {
  return join(getFounderRoot(ventureRoot), "handoffs");
}
export function getHandoffInboxPath(ventureRoot: string): string {
  return join(getHandoffsRoot(ventureRoot), "inbox");
}
export function getHandoffWorkingPath(ventureRoot: string): string {
  return join(getHandoffsRoot(ventureRoot), "working");
}
export function getHandoffOutboxPath(ventureRoot: string): string {
  return join(getHandoffsRoot(ventureRoot), "outbox");
}
export function getHandoffFailedPath(ventureRoot: string): string {
  return join(getHandoffsRoot(ventureRoot), "failed");
}
export function getBundleFilename(runId: string): string {
  return `${runId}.json`;
}
export function getResultFilename(runId: string): string {
  return `${runId}.result.json`;
}

// --- Stage folders (pipeline stages map to numbered dirs) ---
export const STAGE_DIRS = {
  inbox: "00_inbox",
  research: "01_research",
  validation: "02_validation",
  brand: "03_brand",
  uk: "04_uk_business",
  finance: "05_finance",
  product: "06_product",
  build: "07_build",
  launch: "08_launch",
  operate: "09_operate",
} as const;

export function getStagePath(ventureRoot: string, stage: keyof typeof STAGE_DIRS): string {
  return join(ventureRoot, STAGE_DIRS[stage]);
}

// --- Artifact output conventions ---
export function getBrandNamesDir(ventureRoot: string): string {
  return join(ventureRoot, STAGE_DIRS.brand, "names");
}
export function getLogoConceptsDir(ventureRoot: string): string {
  return join(ventureRoot, STAGE_DIRS.brand, "logo", "concepts");
}
export function getLogoExportsDir(ventureRoot: string): string {
  return join(ventureRoot, STAGE_DIRS.brand, "logo", "exports");
}
export function getBrandKitDir(ventureRoot: string): string {
  return join(ventureRoot, STAGE_DIRS.brand, "brand-kit");
}
export function getBriefDir(ventureRoot: string): string {
  return join(ventureRoot, STAGE_DIRS.product, "brief");
}
export function getSpecsDir(ventureRoot: string): string {
  return join(ventureRoot, STAGE_DIRS.product, "specs");
}

/**
 * pt.41 — Single canonical canvas file capturing the founder's product
 * spec state. The pipeline step writes both this and a derived
 * `product-spec.md` rendered from the canvas. Canvas is the source of
 * truth; markdown is recomputed on every pipeline run.
 */
export function getSpecCanvasPath(ventureRoot: string): string {
  return join(getSpecsDir(ventureRoot), "spec-canvas.json");
}

/** pt.41 — Derived markdown view rendered from the canvas. */
export function getProductSpecMarkdownPath(ventureRoot: string): string {
  return join(getSpecsDir(ventureRoot), "product-spec.md");
}
export function getStitchDir(ventureRoot: string): string {
  return join(ventureRoot, STAGE_DIRS.product, "stitch");
}
export function getWireframesDir(ventureRoot: string): string {
  return join(ventureRoot, STAGE_DIRS.product, "wireframes");
}

/**
 * pt.43 — Screens canvas (the structured screen inventory). Lives
 * inside 06_product/wireframes/ for backward compatibility with the
 * existing WIREFRAME_READY stage + folder convention, but contains a
 * screen INVENTORY (name + shell type + feature mapping) rather than
 * full element-level wireframes. See packages/domain/src/screens.ts
 * for the schema + deliberately-did-not policy.
 */
export function getScreensCanvasPath(ventureRoot: string): string {
  return join(getWireframesDir(ventureRoot), "screens-canvas.json");
}

/** pt.43 — Derived markdown view rendered from the screens canvas. */
export function getScreensMarkdownPath(ventureRoot: string): string {
  return join(getWireframesDir(ventureRoot), "screens.md");
}
export function getAuditsDir(ventureRoot: string): string {
  return join(ventureRoot, STAGE_DIRS.build, "audits");
}

// --- UK Setup (pt.33) ---
// The dirs under 04_uk_business/ already exist in VENTURE_DIR_SKELETON
// (incorporation/, hmrc/, vat/, insurance/, etc.). Helpers here
// surface the paths the pipeline step + UI tab read/write.

export function getUkSetupDir(ventureRoot: string): string {
  return join(ventureRoot, STAGE_DIRS.uk);
}

/** Single canonical canvas file capturing the founder's UK admin state. */
export function getUkSetupCanvasPath(ventureRoot: string): string {
  return join(getUkSetupDir(ventureRoot), "uk-setup.json");
}

export function getIncorporationDir(ventureRoot: string): string {
  return join(ventureRoot, STAGE_DIRS.uk, "incorporation");
}

export function getHmrcDir(ventureRoot: string): string {
  return join(ventureRoot, STAGE_DIRS.uk, "hmrc");
}

export function getInsuranceDir(ventureRoot: string): string {
  return join(ventureRoot, STAGE_DIRS.uk, "insurance");
}

// --- Convenience bundles ---
export type HandoffPaths = {
  inbox: string;
  outbox: string;
  working: string;
  failed: string;
  progress: string;
};

export function ventureHandoffPaths(ventureRoot: string): HandoffPaths {
  const root = getHandoffsRoot(ventureRoot);
  return {
    inbox: join(root, "inbox"),
    outbox: join(root, "outbox"),
    working: join(root, "working"),
    failed: join(root, "failed"),
    progress: join(root, "progress"),
  };
}

/** All dirs that may contain user/AI artifacts to be indexed */
export function ventureArtifactDirs(ventureRoot: string): string[] {
  return [
    join(ventureRoot, STAGE_DIRS.research),
    join(ventureRoot, STAGE_DIRS.validation),
    join(ventureRoot, STAGE_DIRS.brand),
    join(ventureRoot, STAGE_DIRS.uk),
    join(ventureRoot, STAGE_DIRS.product),
    join(ventureRoot, STAGE_DIRS.build),
    join(ventureRoot, STAGE_DIRS.launch),
  ];
}
