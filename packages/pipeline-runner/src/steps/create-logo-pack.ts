import { createLogger } from "@founder-os/logger";
import { getLogoExportsDir } from "@founder-os/workspace-core";
import { materializeBrandPack } from "@founder-os/branding-assets";
import type { BrandBrief } from "@founder-os/branding-core";
import type { Filesystem } from "../fs.js";

const log = createLogger("pipeline-runner:create-logo-pack");

export type CreateLogoPackContext = {
  fs: Filesystem;
  ventureId: string;
  ventureRoot: string;
  brief: BrandBrief;
};

export async function createLogoPackStep(
  ctx: CreateLogoPackContext
): Promise<{ status: string; producedArtifactIds: string[] }> {
  const exportsDir = getLogoExportsDir(ctx.ventureRoot);
  await ctx.fs.mkdir(exportsDir);

  const markerPath = `${exportsDir}/logo.svg`;
  if (await ctx.fs.exists(markerPath)) {
    log.info("Logo pack already exists, skipping");
    return { status: "skipped", producedArtifactIds: [] };
  }

  const pack = materializeBrandPack(ctx.brief);

  for (const [filename, content] of Object.entries(pack)) {
    const filePath = `${exportsDir}/${filename}`;
    await ctx.fs.writeFile(filePath, content);
    log.info(`Wrote ${filename} → ${filePath}`);
  }

  log.info(`Logo pack materialized at ${exportsDir}`);
  return { status: "done", producedArtifactIds: [] };
}
