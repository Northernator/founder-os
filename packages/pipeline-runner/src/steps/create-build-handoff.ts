import type { BrandBrief } from "@founder-os/branding-core";
import type { VentureManifest } from "@founder-os/domain";
import type { HandoffBundle } from "@founder-os/handoff-contract";
import { createBundle } from "@founder-os/handoff-desktop";
import { createLogger } from "@founder-os/logger";
import { getHandoffsRoot } from "@founder-os/workspace-core";
import type { Filesystem } from "../fs.js";

const log = createLogger("pipeline-runner:create-build-handoff");

export type CreateBuildHandoffContext = {
  fs: Filesystem;
  manifest: VentureManifest;
  ventureRoot: string;
  brief: BrandBrief;
};

export async function createBuildHandoffStep(
  ctx: CreateBuildHandoffContext
): Promise<{ status: string; producedArtifactIds: string[]; bundle: HandoffBundle }> {
  const handoffsRoot = getHandoffsRoot(ctx.ventureRoot);
  const inboxDir = `${handoffsRoot}/inbox`;
  await ctx.fs.mkdir(inboxDir);

  const bundle = createBundle({
    ventureId: ctx.manifest.id,
    ventureRoot: ctx.ventureRoot,
    type: "BUILD_FROM_BRIEF",
    artifactRefs: [],
    payload: {
      ventureName: ctx.manifest.name,
      appType: ctx.manifest.appType,
      brandBriefPath: `${ctx.ventureRoot}/03_brand/brand-kit/brand-brief.json`,
      specPath: `${ctx.ventureRoot}/06_product/specs/product-spec.md`,
      stitchConfigPath: `${ctx.ventureRoot}/06_product/stitch/stitch-config.json`,
    },
  });

  const bundlePath = `${inboxDir}/${bundle.runId}.json`;
  await ctx.fs.writeFile(bundlePath, JSON.stringify(bundle, null, 2));
  log.info(`Build handoff bundle written → ${bundlePath}`);

  return { status: "done", producedArtifactIds: [], bundle };
}
