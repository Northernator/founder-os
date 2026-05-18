import type { StageRunResult } from "@founder-os/stage-runners";
import type { Venture, VentureManifest } from "@founder-os/domain";
import { invoke } from "@tauri-apps/api/core";
import { tauriFs } from "./pipeline-fs.js";

export type RunHandoffPackStageResult = {
  result: StageRunResult;
  counts: {
    docsRendered: number;
    rolePacksGenerated: number;
    failed: number;
  };
  steps: {
    brand: "ok" | "missing";
    docs: "ok" | "missing";
    rolePacks: "ok" | "missing";
    inventory: "ok" | "missing";
  };
  checkpointPath?: string;
};

type HandoffPackRunStageIpc =
  | RunHandoffPackStageResult
  | {
      error: string;
    };

export async function runHandoffPackStage(args: {
  venture: Venture;
  manifest: VentureManifest;
  force: boolean;
}): Promise<RunHandoffPackStageResult> {
  const manifestPath = `${args.venture.rootPath}/.founder/manifest-snapshot.json`;
  await tauriFs.writeFile(manifestPath, JSON.stringify(args.manifest, null, 2));
  const ipc = await invoke<HandoffPackRunStageIpc>("handoff_pack_run_stage", {
    ventureRoot: args.venture.rootPath,
    manifestPath,
    force: args.force,
  });
  if ("error" in ipc) {
    throw new Error(`handoff_pack_run_stage sidecar error: ${ipc.error}`);
  }
  return ipc;
}
