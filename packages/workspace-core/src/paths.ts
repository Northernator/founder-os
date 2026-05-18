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
/**
 * The normalized handoff export written by the HANDOFF stage,
 * regardless of provider. Both Stitch and CoDesign emit a
 * HandoffExport-shaped JSON here. BUILD reads this file in slice 7+
 * of the dual-handoff arc.
 */
export function getHandoffExportPath(ventureRoot: string): string {
  return join(getStitchDir(ventureRoot), "handoff-export.json");
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

// --- Media (slice 3 of media arc -- MEDIA_READY stage) ---
// Lives at <root>/10_media/ to avoid collision with 06_product/.
// The skeletal MediaStageRunner writes media-checkpoint.json here;
// later slices add scripts/, storyboards/, renders/, exports/.

export function getMediaDir(ventureRoot: string): string {
  return join(ventureRoot, "10_media");
}

export function getMediaCheckpointPath(ventureRoot: string): string {
  return join(getMediaDir(ventureRoot), "media-checkpoint.json");
}

// Slice 4 of media arc -- subpaths the real-step pipeline writes.
// Mirror the 10_media/ tree from MEDIA-MODULE-SPEC.md sec 3:
//   scripts/   storyboards/   renders/   exports/
// flow-prompts.md sits at the top of 10_media/ so the gemini_flow
// paste-in path is one folder shallower than the auto-rendered output.

export function getMediaScriptsDir(ventureRoot: string): string {
  return join(getMediaDir(ventureRoot), "scripts");
}

export function getMediaScriptJsonPath(ventureRoot: string): string {
  return join(getMediaScriptsDir(ventureRoot), "media-script.json");
}

export function getMediaScriptMdPath(ventureRoot: string): string {
  return join(getMediaScriptsDir(ventureRoot), "media-script.md");
}

export function getMediaStoryboardsDir(ventureRoot: string): string {
  return join(getMediaDir(ventureRoot), "storyboards");
}

export function getStoryboardJsonPath(ventureRoot: string): string {
  return join(getMediaStoryboardsDir(ventureRoot), "storyboard.json");
}

export function getMediaRendersDir(ventureRoot: string): string {
  return join(getMediaDir(ventureRoot), "renders");
}

export function getMediaExportsDir(ventureRoot: string): string {
  return join(getMediaDir(ventureRoot), "exports");
}

export function getLaunchReelPath(ventureRoot: string): string {
  return join(getMediaExportsDir(ventureRoot), "launch-reel.mp4");
}

export function getFlowPromptsPath(ventureRoot: string): string {
  return join(getMediaDir(ventureRoot), "flow-prompts.md");
}

/** All dirs that may contain user/AI artifacts to be indexed */
export function ventureArtifactDirs(ventureRoot: string): string[] {
  return [
    join(ventureRoot, STAGE_DIRS.research),
    join(ventureRoot, STAGE_DIRS.validation),
    join(ventureRoot, STAGE_DIRS.brand),
    join(ventureRoot, STAGE_DIRS.uk),
    join(ventureRoot, STAGE_DIRS.finance),
    join(ventureRoot, STAGE_DIRS.product),
    join(ventureRoot, STAGE_DIRS.build),
    join(ventureRoot, STAGE_DIRS.launch),
    join(ventureRoot, STAGE_DIRS.operate),
    // Post-09_operate stages live outside STAGE_DIRS' fixed keys;
    // pipeline-hardening adds them here so the artifact-index catches
    // what these runners actually produce.
    join(ventureRoot, "10_media"),
    join(ventureRoot, "11_crm"),
    join(ventureRoot, "12_backend"),
    join(ventureRoot, "13_handoff_pack"),
  ];
}

// ---------------------------------------------------------------------------
// 10_media/edits — media-edit stage paths (re-added 2026-05-18 after Edit
// truncation; reconstructed from caller-side imports + the artifact taxonomy
// convention in artifacts-scan.ts).
// ---------------------------------------------------------------------------

/** 10_media/edits/ — media-edit working folder. */
export function getMediaEditDir(ventureRoot: string): string {
  return join(getMediaDir(ventureRoot), "edits");
}

/** 10_media/edits/media-edit-checkpoint.json — runner checkpoint. */
export function getMediaEditCheckpointPath(ventureRoot: string): string {
  return join(getMediaEditDir(ventureRoot), "media-edit-checkpoint.json");
}

/** 10_media/edits/clip-manifest.md — founder-readable drag-drop guide. */
export function getClipManifestPath(ventureRoot: string): string {
  return join(getMediaEditDir(ventureRoot), "clip-manifest.md");
}

/** 10_media/edits/edit-receipt.json — receipt the OpenCut export step writes. */
export function getEditReceiptPath(ventureRoot: string): string {
  return join(getMediaEditDir(ventureRoot), "edit-receipt.json");
}

/** 10_media/exports/edited/launch-reel.mp4 — the polished launch reel. */
export function getEditedReelPath(ventureRoot: string): string {
  return join(getMediaExportsDir(ventureRoot), "edited", "launch-reel.mp4");
}

// ---------------------------------------------------------------------------
// 11_crm — CRM stage paths. Slots after 10_media to keep the post-LAUNCH
// convention. Like getMediaDir() / getBackendDir(), the CRM helpers are
// dedicated rather than threaded through STAGE_DIRS' fixed keys.
// ---------------------------------------------------------------------------

export function getCrmDir(ventureRoot: string): string {
  return join(ventureRoot, "11_crm");
}

/** 11_crm/crm-checkpoint.json — runner checkpoint. */
export function getCrmCheckpointPath(ventureRoot: string): string {
  return join(getCrmDir(ventureRoot), "crm-checkpoint.json");
}

/** 11_crm/crm-instance.json — provisioning result (URL, admin email). */
export function getCrmInstancePath(ventureRoot: string): string {
  return join(getCrmDir(ventureRoot), "crm-instance.json");
}

/** 11_crm/crm-config.json — connection config (host, encrypted API key path). */
export function getCrmConfigPath(ventureRoot: string): string {
  return join(getCrmDir(ventureRoot), "crm-config.json");
}

/** 11_crm/segments/ — ICP + audience segment JSON files. */
export function getCrmSegmentsDir(ventureRoot: string): string {
  return join(getCrmDir(ventureRoot), "segments");
}

/** 11_crm/contacts/ — seed-prospects + seed-research-contacts. */
export function getCrmContactsDir(ventureRoot: string): string {
  return join(getCrmDir(ventureRoot), "contacts");
}

/** 11_crm/opportunities/ — seed-opportunities JSON files. */
export function getCrmOpportunitiesDir(ventureRoot: string): string {
  return join(getCrmDir(ventureRoot), "opportunities");
}

/** 11_crm/templates/ — email-welcome / email-followup / email-demo-invite md. */
export function getCrmTemplatesDir(ventureRoot: string): string {
  return join(getCrmDir(ventureRoot), "templates");
}

/** 11_crm/campaigns/ — campaign JSON files. */
export function getCrmCampaignsDir(ventureRoot: string): string {
  return join(getCrmDir(ventureRoot), "campaigns");
}

/** 11_crm/campaigns/launch-campaign.json — the canonical launch campaign. */
export function getCrmLaunchCampaignPath(ventureRoot: string): string {
  return join(getCrmCampaignsDir(ventureRoot), "launch-campaign.json");
}

// ---------------------------------------------------------------------------
// 12_backend — Backend stage paths. Slots after 11_crm. Pipeline-wise the
// BACKEND runs between HANDOFF and BUILD, but the folder numbering follows
// the existing "new stages go at the end" precedent.
// ---------------------------------------------------------------------------

export function getBackendDir(ventureRoot: string): string {
  return join(ventureRoot, "12_backend");
}

/** 12_backend/backend-checkpoint.json — runner checkpoint. */
export function getBackendCheckpointPath(ventureRoot: string): string {
  return join(getBackendDir(ventureRoot), "backend-checkpoint.json");
}

/** 12_backend/backend-export.json — normalized BackendExport (BUILD reads this). */
export function getBackendExportPath(ventureRoot: string): string {
  return join(getBackendDir(ventureRoot), "backend-export.json");
}

/** 12_backend/sdk/ — generated client SDK files. */
export function getBackendSdkDir(ventureRoot: string): string {
  return join(getBackendDir(ventureRoot), "sdk");
}

// ---------------------------------------------------------------------------
// 13_handoff_pack — Handoff Pack stage paths. Tree B (audience-organised
// branded PDFs) per HANDOFF-PACK-MODULE-SPEC.md sec 3. Tree A is the
// canonical pipeline runtime (00..12); tree B is rendered output.
// ---------------------------------------------------------------------------

export function getHandoffPackDir(ventureRoot: string): string {
  return join(ventureRoot, "13_handoff_pack");
}

/** 13_handoff_pack/.brand/ — brand assets the PDF renderer pulls from. */
export function getHandoffPackBrandDir(ventureRoot: string): string {
  return join(getHandoffPackDir(ventureRoot), ".brand");
}

/** 13_handoff_pack/.brand/brand-tokens.json — extracted BrandTokens JSON. */
export function getHandoffPackBrandTokensPath(ventureRoot: string): string {
  return join(getHandoffPackBrandDir(ventureRoot), "brand-tokens.json");
}

/** 13_handoff_pack/.brand/logo.svg — vector logo for headers. */
export function getHandoffPackBrandLogoSvgPath(ventureRoot: string): string {
  return join(getHandoffPackBrandDir(ventureRoot), "logo.svg");
}

/** 13_handoff_pack/.brand/logo.png — raster fallback for engines without SVG. */
export function getHandoffPackBrandLogoPngPath(ventureRoot: string): string {
  return join(getHandoffPackBrandDir(ventureRoot), "logo.png");
}

/** 13_handoff_pack/handoff-pack-checkpoint.json — runner checkpoint. */
export function getHandoffPackCheckpointPath(ventureRoot: string): string {
  return join(getHandoffPackDir(ventureRoot), "handoff-pack-checkpoint.json");
}

/** 13_handoff_pack/index.json — manifest of every emitted doc. */
export function getHandoffPackIndexPath(ventureRoot: string): string {
  return join(getHandoffPackDir(ventureRoot), "index.json");
}

/** 13_handoff_pack/.config/pdf-template.json — PDF template config. */
export function getHandoffPackPdfTemplateConfigPath(ventureRoot: string): string {
  return join(getHandoffPackDir(ventureRoot), ".config", "pdf-template.json");
}

/** 13_handoff_pack/{category}/{slot}-{slug}.pdf — a single rendered doc. */
export function getHandoffPackDocPdfPath(
  ventureRoot: string,
  category: string,
  slot: string,
  slug: string,
): string {
  return join(getHandoffPackDir(ventureRoot), category, `${slot}-${slug}.pdf`);
}

/** 13_handoff_pack/role-packs/{role}.pdf — a single role pack. */
export function getHandoffPackRolePackPath(ventureRoot: string, role: string): string {
  return join(getHandoffPackDir(ventureRoot), "role-packs", `${role}.pdf`);
}
