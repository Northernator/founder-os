/**
 * config_only SocialAdapter -- the always-available "save the draft, do
 * not actually post" backend.
 *
 * Purpose:
 *   - Review-before-send workflow: user composes the post in
 *     <SocialActions>, hits Post, but the venture's backend is set to
 *     `config_only` -- the draft lands in 13_social/drafts/ for human
 *     review. Nothing goes out. Useful for compliance / approval flows.
 *   - Resolver fallback: if every other backend in enabledBackends is
 *     unavailable AND config_only is in the list, the resolver picks
 *     it so the user gets a draft they can post by hand.
 *
 * Lives in /node (not the client barrel) because it writes to disk via
 * paths.writeDraft.
 */

import type {
  SocialAdapter,
  SocialAvailability,
  SocialLoginState,
  SocialPost,
  SocialResult,
  SocialResultRow,
} from "@founder-os/social-core";

import { writeDraft } from "./paths.js";

export type CreateConfigOnlyProviderOpts = {
  /**
   * Per-venture root. Drafts land under <ventureRoot>/13_social/drafts/.
   */
  ventureRoot: string;
};

export function createConfigOnlyProvider(
  opts: CreateConfigOnlyProviderOpts
): SocialAdapter {
  const { ventureRoot } = opts;
  return {
    name: "config_only",
    async available(): Promise<SocialAvailability> {
      return { available: true };
    },
    async loginState(): Promise<SocialLoginState> {
      // No platforms have meaningful login state under config_only --
      // we never call any platform.
      return {};
    },
    async post(payload: SocialPost): Promise<SocialResult> {
      const postedAt = new Date().toISOString();
      let draftPath: string | undefined;
      let writeError: string | undefined;
      try {
        draftPath = await writeDraft(ventureRoot, payload, postedAt);
      } catch (err) {
        writeError = (err as Error).message;
      }
      const rows: SocialResultRow[] = payload.platforms.map((platform) => ({
        platform,
        success: false,
        error: writeError
          ? `config_only: failed to persist draft -- ${writeError}`
          : `config_only backend: draft written, no platform call made.`,
        errorCode: "unknown",
        timestamp: postedAt,
      }));
      return {
        ventureSlug: payload.ventureSlug,
        backend: "config_only",
        postedAt,
        rows,
        rawAdapterPayload: { draftPath, writeError },
      };
    },
  };
}
