// @founder-os/media-providers -- engine-specific implementations of the
// MediaProvider contract from @founder-os/media-core.
//
// Slice 2 ships only the HyperFrames provider (tier_0). Wan2 / CogVideoX /
// Gemini Flow / Gemini API providers slot in here in later slices, each
// behind its own factory + barrel export.

export {
  createHyperframesProvider,
  HyperframesLintError,
  HyperframesLayoutError,
  type CreateHyperframesProviderOpts,
} from "./hyperframes-provider.js";

export {
  bootstrapHyperframesProject,
  addCatalogItems,
  assertHyperframesProject,
  projectPaths,
  writeVariablesFile,
  type BootstrapOpts,
  type ProjectPaths,
} from "./ensure-project.js";

export {
  runHyperframes,
  runHyperframesJson,
  HyperframesExitError,
  HyperframesNotFoundError,
  HyperframesTimeoutError,
  type SpawnOpts,
  type SpawnResult,
} from "./spawn.js";
