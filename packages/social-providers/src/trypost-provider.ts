/**
 * TryPost provider -- TIER_3 STUB.
 *
 * TryPost (github.com/trypostit/trypost) is a poster with an MCP server
 * surface, which means once the in-Founder-OS MCP gateway lands the
 * adapter can drive it via natural-language prompts ("schedule the
 * launch reel for Tuesday morning") rather than JSON payloads.
 *
 * SLICE 2 IS A STUB. `available()` returns false and `post()` throws
 * TrypostNotImplementedError. Mirrors brightbean-provider's stub shape.
 *
 * What a future slice would implement
 * -----------------------------------
 *  - Detection: probe the running TryPost instance + verify its MCP
 *    server endpoint is reachable.
 *  - Translation: SocialPost -> TryPost's REST schema OR -> an MCP
 *    tool-call envelope, depending on whether the venture wants the
 *    deterministic or the natural-language path.
 *  - Workspace + carousel handling: TryPost's "AI carousel generator"
 *    is an upsell over plain posting; expose it as an opt-in flag.
 *
 * The resolver in @founder-os/social-providers will pick trypost only
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

export interface TrypostProviderOpts {
  /** TryPost instance base URL, e.g. http://localhost:8000. */
  baseUrl?: string;
  /** Name of the env var holding the TryPost API token. */
  apiTokenEnvVar?: string;
  /**
   * If true, attempt to drive TryPost via its MCP-server surface rather
   * than its REST surface. A future slice will implement this; the
   * stub records the flag for parity but ignores it.
   */
  useMcpSurface?: boolean;
}

export class TrypostNotImplementedError extends Error {
  constructor() {
    super(
      "TryPost adapter is a slice-2 stub. A future slice will wire the " +
        "TryPost REST + MCP surfaces. Until then, the resolver should " +
        "not be picking trypost -- if you see this thrown, available() " +
        "is reporting incorrectly."
    );
    this.name = "TrypostNotImplementedError";
  }
}

/**
 * Build a stub TryPost SocialAdapter. Type-clean so the resolver can
 * already address it; runtime is honest about being unimplemented.
 */
export function createTrypostProvider(
  _opts: TrypostProviderOpts = {}
): SocialAdapter {
  return {
    name: "trypost",
    async available(): Promise<SocialAvailability> {
      return {
        available: false,
        reason: "TryPost adapter is a stub -- not yet implemented.",
      };
    },
    async loginState(): Promise<SocialLoginState> {
      return {};
    },
    async post(_payload: SocialPost): Promise<SocialResult> {
      throw new TrypostNotImplementedError();
    },
  };
}
