// @founder-os/media-providers -- engine-specific implementations of the
// MediaProvider contract from @founder-os/media-core.
//
// Slice 2 shipped HyperFrames (tier_0). Slice 6 added typed STUBS for
// Wan2 (tier_1, ComfyUI HTTP), CogVideoX (tier_2, Python+diffusers),
// and Veo (tier_4, Gemini API). Each stub's available() returns false
// and render() throws -- the resolver never picks them, but the
// contract surface is locked so slice 7+ can fill in subprocess /
// HTTP internals without changing callers.

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

export {
  createWan2Provider,
  Wan2NotImplementedError,
  type Wan2ProviderOpts,
} from "./wan2-provider.js";

export {
  createCogVideoXProvider,
  CogVideoXNotImplementedError,
  type CogVideoXProviderOpts,
} from "./cogvideox-provider.js";

export {
  createVeoProvider,
  VeoNotImplementedError,
  type VeoProviderOpts,
} from "./veo-provider.js";
