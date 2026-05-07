/**
 * Back-compat shim for slice 5 of the dual-handoff arc.
 *
 * Pre-slice-5: this file held the StitchStageRunner class. Slice 5
 * moved the implementation to handoff-runner.ts (renamed
 * StitchStageRunner -> HandoffStageRunner) and added per-venture
 * provider dispatch. The legacy export name is preserved here as an
 * alias so the desktop helper (`run-stitch-stage.ts`) and any
 * direct-path imports (e.g. log-strings.test.ts: `import("../src/runners/stitch-runner.js")`)
 * keep working unchanged.
 *
 * New code should import HandoffStageRunner from
 * `@founder-os/stage-runners` directly.
 */
export {
  HandoffStageRunner as StitchStageRunner,
  type HandoffStageRunnerOpts as StitchStageRunnerOpts,
} from "./handoff-runner.js";
