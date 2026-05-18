/**
 * pickActiveSocialAdapter -- walks the configured tier list and returns
 * the first adapter whose available() resolves to { available: true }.
 *
 * Adapter.available() returns the SocialAvailability envelope shape
 * { available: boolean, reason?: string }, so the resolver inspects
 * `.available` rather than treating the return as a raw boolean. The
 * `reason` is captured in the per-attempt trace so the FailedRunBanner
 * can show "social-poster skipped: sp CLI not found on PATH" instead
 * of an opaque skip.
 *
 * Mirrors the @founder-os/backend-providers and @founder-os/crm-providers
 * resolver shape, adapted to the SocialAdapter envelope.
 */

import type {
  SocialAdapter,
  SocialBackend,
} from "@founder-os/social-core";

export type SocialResolverInput = {
  /**
   * Ordered list of adapters to try, by backend name. The first one
   * whose available() returns { available: true } wins.
   */
  tierList: ReadonlyArray<SocialBackend>;
  /**
   * Map from backend name to a SocialAdapter instance. Adapters not in
   * the map are silently skipped (lets callers pass an incomplete set
   * during slice 5a-equivalent UI work when only some adapters are
   * wired).
   */
  adapters: Partial<Record<SocialBackend, SocialAdapter>>;
};

export type SocialResolverAttempt = {
  backend: SocialBackend;
  available: boolean;
  /**
   * Reason from the SocialAvailability envelope when available=false.
   * Useful for the desktop pill tooltip + the FailedRunBanner.
   */
  reason?: string;
  /**
   * Set when an adapter isn't in the map at all.
   */
  skipped?: boolean;
};

export type SocialResolverResult = {
  /**
   * The picked adapter. null if none of the configured adapters reported
   * available=true -- callers should handle by surfacing a "no backend
   * available" UI state.
   */
  adapter: SocialAdapter | null;
  /**
   * Tier-by-tier probe trace.
   */
  attempts: ReadonlyArray<SocialResolverAttempt>;
};

export async function pickActiveSocialAdapter(
  input: SocialResolverInput
): Promise<SocialResolverResult> {
  const attempts: SocialResolverAttempt[] = [];

  for (const backend of input.tierList) {
    const candidate = input.adapters[backend];
    if (!candidate) {
      attempts.push({ backend, available: false, skipped: true });
      continue;
    }
    try {
      const probe = await candidate.available();
      attempts.push({
        backend,
        available: probe.available,
        reason: probe.reason,
      });
      if (probe.available) {
        return { adapter: candidate, attempts };
      }
    } catch (err) {
      attempts.push({
        backend,
        available: false,
        reason: (err as Error).message,
      });
    }
  }

  return { adapter: null, attempts };
}
