/**
 * Veo (Gemini API) provider -- TIER_4 STUB. Slice 6 of the media arc.
 *
 * Google's Veo is the highest-quality video generation tier. It runs
 * via the Gemini API as a long-running operation: POST a generate
 * request, poll the operation until complete, then download the MP4.
 * Per project policy: subscription-first; this provider is paid
 * opt-in only. Each render is billed per second of generated video.
 *
 * SLICE 6 IS A STUB. `available()` returns false and `render()`
 * throws VeoNotImplementedError. Future implementors only touch the
 * internals; the factory + options shape is locked.
 *
 * What slice 7+ would implement
 * -----------------------------
 *  - Use @google/genai SDK or the raw HTTPS API
 *  - GoogleGenAI(apiKey) -> models.generateContent({model:"veo-3.1-fast",
 *    contents: [{prompt: shot.prompt, ...refImages}]}) returns LRO
 *  - Poll the LRO via operations.get(operation.name) until done
 *  - Download the MP4 from the returned uri (signed Google Cloud URL)
 *  - Stream to <outDir>/shot-<sceneId>.mp4
 *  - Surface per-render cost (Veo bills per second of output) in
 *    MediaRenderResult.meta so the finance step can track spend
 *    against the venture's media-spend cap
 *
 * The resolver in @founder-os/media-core picks veo last in the tier
 * list (after gemini_flow paste-in) and only when veo is explicitly
 * configured -- per the subscription-first policy, paid Veo never
 * fires by default.
 */
import type { MediaProvider, MediaRenderResult, Shot } from "@founder-os/media-core";

export interface VeoProviderOpts {
  /**
   * Gemini API key. REQUIRED. Per project policy: subscription-first;
   * this provider is paid opt-in only. Surface the key from a secure
   * store (Tauri's keyring, OS credential manager) -- never commit.
   */
  apiKey: string;
  /**
   * Veo model variant.
   *   - "veo-3.1-fast" -- cheaper, lower quality, faster turnaround.
   *   - "veo-3.1"      -- higher quality, slower, more expensive.
   * Default "veo-3.1-fast" (cost-conscious).
   */
  model?: "veo-3.1-fast" | "veo-3.1";
  /**
   * LRO poll cadence in ms. Veo renders take 60-300s depending on
   * length + quality, so polling every 5s is reasonable. Default 5000.
   */
  pollIntervalMs?: number;
  /**
   * Hard timeout per shot. Veo can take a few minutes for longer
   * shots; default 600_000 (10 minutes) gives headroom.
   */
  timeoutMs?: number;
}

export class VeoNotImplementedError extends Error {
  constructor() {
    super(
      "Veo provider is a slice-6 stub. Slice 7+ will wire the @google/genai " +
        "SDK with LRO polling + MP4 download. Until then, the resolver " +
        "should not be picking veo -- if you see this thrown, available() " +
        "is reporting incorrectly. Note: Veo is paid (per-second billing); " +
        "the runner-side gemini_flow paste-in path is the free alternative " +
        "via your existing subscription.",
    );
    this.name = "VeoNotImplementedError";
  }
}

/**
 * Build a stub Veo MediaProvider. Type-clean so the helper + resolver
 * can address it; runtime is honest about being unimplemented.
 *
 * Note the apiKey is REQUIRED in opts -- this enforces opt-in at
 * construction time so paid renders can never fire from a default config.
 */
export function createVeoProvider(_opts: VeoProviderOpts): MediaProvider {
  return {
    name: "gemini_api",
    async available(): Promise<boolean> {
      // Slice 6: stub. Always false so the resolver never picks veo.
      // Slice 7+: hit GET https://generativelanguage.googleapis.com/v1beta/models
      // with the API key to confirm reachability + key validity.
      return false;
    },
    async render(_shot: Shot, _outDir: string): Promise<MediaRenderResult> {
      throw new VeoNotImplementedError();
    },
  };
}
