/**
 * Wan 2.2 provider -- TIER_1 STUB. Slice 6 of the media arc.
 *
 * Wan 2.2 is HeyGen-tier open-source local AI video generation that
 * runs through ComfyUI's HTTP API (default port 8188). The model
 * needs an RTX 4090-class GPU to be useful; with weaker GPUs it
 * either OOMs or runs at unusable wall-clock speeds.
 *
 * SLICE 6 IS A STUB. `available()` returns false and `render()`
 * throws Wan2NotImplementedError with a helpful pointer at what slice
 * 7+ would need to wire up. The factory + options shape is locked
 * so future implementors only touch the internals of render(), not
 * the public surface.
 *
 * What slice 7+ would implement
 * -----------------------------
 *  - GET <comfyUiUrl>/system_stats to confirm reachability
 *  - POST <comfyUiUrl>/prompt with the workflow JSON wrapping the
 *    Wan2 nodes; the server returns { prompt_id }
 *  - Poll GET <comfyUiUrl>/history/<prompt_id> at pollIntervalMs
 *    until status === "completed"
 *  - Download the rendered MP4 from <comfyUiUrl>/view?filename=...
 *  - Stream it to <outDir>/shot-<sceneId>.mp4
 *
 * The resolver in @founder-os/media-core will pick wan2 for cinematic
 * / b-roll / cameo-style shots when the Wan2 provider is the first
 * available tier in the venture's tier list.
 */
import type { MediaProvider, MediaRenderResult, Shot } from "@founder-os/media-core";

export interface Wan2ProviderOpts {
  /** ComfyUI HTTP base URL. Default: http://localhost:8188. */
  comfyUiUrl?: string;
  /**
   * Path on disk to a ComfyUI workflow JSON wrapping the Wan2 nodes,
   * or an inline workflow object. The runner-side translator will
   * thread the shot's prompt + reference frames into the right node
   * inputs.
   */
  workflowPath?: string;
  /** /history/<prompt_id> poll cadence. Default: 1000 ms. */
  pollIntervalMs?: number;
  /** Hard timeout for one shot. Default: 300_000 ms (5 minutes). */
  timeoutMs?: number;
}

export class Wan2NotImplementedError extends Error {
  constructor() {
    super(
      "Wan2 provider is a slice-6 stub. Slice 7+ will wire the ComfyUI " +
        "HTTP integration (POST /prompt, poll /history/<id>, download " +
        "/view). Until then, the resolver should not be picking wan2 -- " +
        "if you see this thrown, available() is reporting incorrectly.",
    );
    this.name = "Wan2NotImplementedError";
  }
}

/**
 * Build a stub Wan2 MediaProvider. Type-clean so the helper + resolver
 * can already address it; runtime is honest about being unimplemented.
 */
export function createWan2Provider(_opts: Wan2ProviderOpts = {}): MediaProvider {
  return {
    name: "wan2",
    async available(): Promise<boolean> {
      // Slice 6: stub. Always false so the resolver never picks wan2.
      // Slice 7+: probe <comfyUiUrl>/system_stats, return true on 200.
      return false;
    },
    async render(_shot: Shot, _outDir: string): Promise<MediaRenderResult> {
      throw new Wan2NotImplementedError();
    },
  };
}
