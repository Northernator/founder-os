import type { BrandBrief } from "@founder-os/branding-core";
import type { VentureManifest } from "@founder-os/domain";
import {
  type HandoffBundle,
  type HandoffExport,
  type HandoffRequestType,
  safeParseHandoffExport,
} from "@founder-os/handoff-contract";
import { createBundle } from "@founder-os/handoff-desktop";
import { createLogger } from "@founder-os/logger";
import { getHandoffExportPath, getHandoffsRoot } from "@founder-os/workspace-core";
import type { Filesystem } from "../fs.js";

const log = createLogger("pipeline-runner:create-build-handoff");

export type CreateBuildHandoffContext = {
  fs: Filesystem;
  manifest: VentureManifest;
  ventureRoot: string;
  brief: BrandBrief;
};

/**
 * Build the handoff bundle the VS Code extension consumes.
 *
 * Slice 7 of the dual-handoff arc: BUILD now reads the normalized
 * handoff-export.json (written by Stitch or CoDesign at HANDOFF time)
 * and surfaces its parsed contents -- source, html, prompt, parameters,
 * tokens -- inside the bundle payload. The extension can use the
 * sliders directly (CoDesign path) or the prompt (Stitch path)
 * without re-reading the file.
 *
 * Bundle types:
 *   - BUILD_FROM_HANDOFF_EXPORT  when handoff-export.json is present
 *     and parses successfully. Payload includes the full export plus
 *     the legacy paths so older extension code paths still work.
 *   - BUILD_FROM_BRIEF           fallback when the export is missing
 *     or unparseable. Same shape as before. The validate() preflight
 *     already surfaces the missing export, so reaching this fallback
 *     here is the "force run anyway" / "export written by an
 *     incompatible producer" path.
 */
export async function createBuildHandoffStep(
  ctx: CreateBuildHandoffContext
): Promise<{ status: string; producedArtifactIds: string[]; bundle: HandoffBundle }> {
  const handoffsRoot = getHandoffsRoot(ctx.ventureRoot);
  const inboxDir = `${handoffsRoot}/inbox`;
  await ctx.fs.mkdir(inboxDir);

  const handoffExportPath = getHandoffExportPath(ctx.ventureRoot);
  const handoffExport = await tryLoadHandoffExport(ctx.fs, handoffExportPath);

  // Choose bundle type based on whether the normalized export was
  // available. Existing payload keys preserved so VS Code paths that
  // already read brandBriefPath / specPath / stitchConfigPath keep
  // working unchanged.
  const bundleType: HandoffRequestType = handoffExport
    ? "BUILD_FROM_HANDOFF_EXPORT"
    : "BUILD_FROM_BRIEF";

  const basePayload = {
    ventureName: ctx.manifest.name,
    appType: ctx.manifest.appType,
    brandBriefPath: `${ctx.ventureRoot}/03_brand/brand-kit/brand-brief.json`,
    specPath: `${ctx.ventureRoot}/06_product/specs/product-spec.md`,
    stitchConfigPath: `${ctx.ventureRoot}/06_product/stitch/stitch-config.json`,
  };

  const payload = handoffExport
    ? {
        ...basePayload,
        handoffSource: handoffExport.source,
        handoffExportPath,
        handoffExport,
      }
    : basePayload;

  const bundle = createBundle({
    ventureId: ctx.manifest.id,
    ventureRoot: ctx.ventureRoot,
    type: bundleType,
    artifactRefs: [],
    payload,
  });

  const bundlePath = `${inboxDir}/${bundle.runId}.json`;
  await ctx.fs.writeFile(bundlePath, JSON.stringify(bundle, null, 2));
  log.info(
    `Build handoff bundle written → ${bundlePath} (type=${bundleType}${
      handoffExport
        ? `, source=${handoffExport.source}, parameters=${
            handoffExport.parameters ? Object.keys(handoffExport.parameters).length : 0
          }`
        : ""
    })`
  );

  return { status: "done", producedArtifactIds: [], bundle };
}

/**
 * Best-effort load of handoff-export.json. Returns null on any
 * failure (missing file, unreadable, invalid JSON, schema mismatch)
 * and logs the reason -- the caller falls back to BUILD_FROM_BRIEF.
 * BuildStageRunner.validate() is the strict gatekeeper; this function
 * is permissive so the run() path can still produce *some* bundle if
 * the export got corrupted between validate and run.
 */
async function tryLoadHandoffExport(
  fs: Filesystem,
  path: string
): Promise<HandoffExport | null> {
  if (!(await fs.exists(path))) {
    log.info(`No handoff-export at ${path}; falling back to BUILD_FROM_BRIEF`);
    return null;
  }
  let raw: string;
  try {
    raw = await fs.readFile(path);
  } catch (err) {
    log.warn(
      `handoff-export read failed (${err instanceof Error ? err.message : String(err)}); falling back`
    );
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    log.warn(
      `handoff-export JSON.parse failed (${
        err instanceof Error ? err.message : String(err)
      }); falling back`
    );
    return null;
  }
  const parsed = safeParseHandoffExport(json);
  if (!parsed.success) {
    log.warn(
      `handoff-export schema mismatch (${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}); falling back`
    );
    return null;
  }
  return parsed.data;
}
