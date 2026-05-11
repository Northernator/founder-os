/**
 * CogVideoX provider -- TIER_2 STUB. Slice 6 of the media arc.
 *
 * CogVideoX is HuggingFace's open-source video diffusion model. The
 * 2B variant runs on a GTX 1080 Ti and up; the 5B variant needs an
 * RTX 3060+ with 12 GB VRAM. Integration is via a small Python
 * helper script that loads CogVideoXPipeline from the diffusers
 * library, reads JSON from stdin, writes MP4 to disk, and prints the
 * output path to stdout.
 *
 * SLICE 6 IS A STUB. `available()` returns false and `render()`
 * throws CogVideoXNotImplementedError. Future implementors only
 * touch the internals; the factory + options shape is locked.
 *
 * What slice 7+ would implement
 * -----------------------------
 *  - Spawn `python --version` to confirm the python binary works
 *  - Spawn `python <scriptPath> --check` to confirm diffusers is
 *    importable and the model files are downloaded
 *  - For each shot: spawn `python <scriptPath> --variant <2b|5b>
 *    --output <outDir>/shot-<sceneId>.mp4`, pipe shot metadata
 *    (prompt, durationSec, fps) as JSON via stdin, await stdout for
 *    the path
 *  - Match the canonical Founder OS Node-side spawn pattern from
 *    sales-agents/claude-cli-caller (timeout via SIGTERM, ENOENT
 *    branch tagged distinctly, buffered utf8 stdio pipes)
 *
 * The resolver in @founder-os/media-core picks cogvideox after wan2
 * in the default tier list, so it serves as a "still local but
 * lighter GPU" fallback when ComfyUI/Wan2 is unavailable.
 */
import type { MediaProvider, MediaRenderResult, Shot } from "@founder-os/media-core";

export interface CogVideoXProviderOpts {
  /** Python binary, default "python" (must be on PATH or absolute). */
  pythonBin?: string;
  /**
   * Absolute path to the render helper script. Reads shot JSON from
   * stdin, writes MP4 to the path passed via --output, and prints the
   * resolved output path to stdout on success.
   */
  scriptPath?: string;
  /**
   * Model variant. "2b" runs on a GTX 1080 Ti+; "5b" needs RTX 3060
   * with 12 GB VRAM. Default "2b" (broader compat).
   */
  modelVariant?: "2b" | "5b";
  /** Hard timeout per shot. Default 300_000 ms. */
  timeoutMs?: number;
}

export class CogVideoXNotImplementedError extends Error {
  constructor() {
    super(
      "CogVideoX provider is a slice-6 stub. Slice 7+ will wire the " +
        "Python+diffusers spawn integration. Until then, the resolver " +
        "should not be picking cogvideox -- if you see this thrown, " +
        "available() is reporting incorrectly.",
    );
    this.name = "CogVideoXNotImplementedError";
  }
}

/**
 * Build a stub CogVideoX MediaProvider. Type-clean so the helper +
 * resolver can address it; runtime is honest about being unimplemented.
 */
export function createCogVideoXProvider(_opts: CogVideoXProviderOpts = {}): MediaProvider {
  return {
    name: "cogvideox",
    async available(): Promise<boolean> {
      // Slice 6: stub. Always false so the resolver never picks cogvideox.
      // Slice 7+: spawn python and run a --check against the script.
      return false;
    },
    async render(_shot: Shot, _outDir: string): Promise<MediaRenderResult> {
      throw new CogVideoXNotImplementedError();
    },
  };
}
