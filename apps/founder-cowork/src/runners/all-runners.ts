/**
 * Builds the HandoffRunnerMap consumed by the dispatcher. Each entry is a
 * thin closure over runHandoffWithSdk with the right system prompt + output
 * subdir for that bundle type.
 */

import type {
  HandoffBundle,
  HandoffRequestType,
  HandoffResult,
} from "@founder-os/handoff-contract";
import type { HandoffRunnerContext, HandoffRunnerMap } from "@founder-os/handoff-vscode";
import { runHandoffWithSdk } from "./handoff-sdk-runner.js";
import { PROMPTS_BY_TYPE } from "./system-prompts.js";

interface PerTypeConfig {
  outputSubdir?: string;
  maxTokens?: number;
}

const CONFIG: Record<HandoffRequestType, PerTypeConfig> = {
  BUILD_FROM_BRIEF: { outputSubdir: "07_build" },
  // Slice 7 of the dual-handoff arc -- bundle carries a normalized
  // HandoffExport (Stitch or CoDesign). Same output subdir + token
  // budget as the legacy stitch path.
  BUILD_FROM_HANDOFF_EXPORT: { outputSubdir: "07_build", maxTokens: 16_000 },
  BUILD_FROM_STITCH_EXPORT: { outputSubdir: "07_build", maxTokens: 16_000 },
  GENERATE_CODE_WIKI: { outputSubdir: "" /* writes under docs/wiki/ from prompt */ },
  GENERATE_TRUTH_LAYER: { outputSubdir: "" },
  RUN_AUDIT: { outputSubdir: "" },
  RUN_RED_TEAM_PASS: { outputSubdir: "" },
};

function makeRunner(type: HandoffRequestType) {
  const cfg = CONFIG[type];
  return (bundle: HandoffBundle, ctx: HandoffRunnerContext): Promise<HandoffResult> =>
    runHandoffWithSdk({
      bundle,
      ventureRoot: ctx.ventureRoot,
      claudeBinary: ctx.claudeBinary,
      systemPrompt: PROMPTS_BY_TYPE[type],
      outputSubdir: cfg.outputSubdir,
      maxTokens: cfg.maxTokens,
      onProgress: ctx.onProgress,
    });
}

export const RUNNERS: HandoffRunnerMap = {
  BUILD_FROM_BRIEF: makeRunner("BUILD_FROM_BRIEF"),
  BUILD_FROM_HANDOFF_EXPORT: makeRunner("BUILD_FROM_HANDOFF_EXPORT"),
  BUILD_FROM_STITCH_EXPORT: makeRunner("BUILD_FROM_STITCH_EXPORT"),
  GENERATE_CODE_WIKI: makeRunner("GENERATE_CODE_WIKI"),
  GENERATE_TRUTH_LAYER: makeRunner("GENERATE_TRUTH_LAYER"),
  RUN_AUDIT: makeRunner("RUN_AUDIT"),
  RUN_RED_TEAM_PASS: makeRunner("RUN_RED_TEAM_PASS"),
};
