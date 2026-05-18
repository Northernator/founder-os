/**
 * BrightBean Studio provider -- TIER_2 STUB.
 *
 * BrightBean Studio (github.com/brightbeanxyz/brightbean-studio) is a no-
 * paywall self-hostable poster covering the broadest platform set of any
 * open-source option (Facebook, Instagram, LinkedIn, TikTok, YouTube,
 * Pinterest, Threads, Bluesky, GBP, Mastodon).
 *
 * SLICE 2 IS A STUB. `available()` returns false and `post()` throws
 * BrightbeanNotImplementedError with a pointer at what a future slice
 * would need to wire up. The factory + opts shape is locked so future
 * implementors only touch the internals of post(), not the public
 * surface. Same precedent as media-providers' wan2/cogvideox/veo stubs.
 *
 * What a future slice would implement
 * -----------------------------------
 *  - HTTP client against the running BrightBean instance (REST API
 *    surface is documented at brightbean's repo).
 *  - Per-account authentication: BrightBean handles OAuth server-side,
 *    so the adapter only needs an API token.
 *  - Two-step media upload (similar to Postiz's media flow).
 *  - Map SocialPost -> BrightBean's request schema.
 *
 * The resolver in @founder-os/social-providers will pick brightbean only
 * when a venture explicitly puts it earlier in the tier list. Until the
 * stub is replaced, available()=false ensures the resolver skips it.
 */
import type {
  SocialAdapter,
  SocialAvailability,
  SocialLoginState,
  SocialPost,
  SocialResult,
} from "@founder-os/social-core";

export interface BrightbeanProviderOpts {
  /** BrightBean instance base URL, e.g. http://localhost:7777. */
  baseUrl?: string;
  /** Name of the env var holding the BrightBean API token. */
  apiTokenEnvVar?: string;
}

export class BrightbeanNotImplementedError extends Error {
  constructor() {
    super(
      "BrightBean Studio adapter is a slice-2 stub. A future slice will " +
        "wire the BrightBean REST API. Until then, the resolver should " +
        "not be picking brightbean -- if you see this thrown, available() " +
        "is reporting incorrectly."
    );
    this.name = "BrightbeanNotImplementedError";
  }
}

/**
 * Build a stub BrightBean SocialAdapter. Type-clean so the resolver can
 * already address it; runtime is honest about being unimplemented.
 */
export function createBrightbeanProvider(
  _opts: BrightbeanProviderOpts = {}
): SocialAdapter {
  return {
    name: "brightbean",
    async available(): Promise<SocialAvailability> {
      return {
        available: false,
        reason: "BrightBean adapter is a stub -- not yet implemented.",
      };
    },
    async loginState(): Promise<SocialLoginState> {
      return {};
    },
    async post(_payload: SocialPost): Promise<SocialResult> {
      throw new BrightbeanNotImplementedError();
    },
  };
}
