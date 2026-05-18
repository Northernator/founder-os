/**
 * pickActiveBackendProvider -- walks the configured tier list and returns
 * the first provider whose available() resolves true.
 *
 * config_only is always available, so the resolver never returns null as
 * long as the tier list ends with config_only. Tier lists that
 * accidentally omit it can still return null -- callers should defend
 * against that.
 *
 * Mirrors the @founder-os/crm-providers resolver shape but trimmed for
 * the backend provider surface (no engine-hint signals -- backend choice
 * is per-venture, not per-shot).
 */

import type { BackendEngine, BackendProvider } from "@founder-os/backend-core";

export type ResolverInput = {
  /**
   * Ordered list of providers to try, by engine name. The first one
   * whose available() returns true wins.
   */
  tierList: ReadonlyArray<BackendEngine>;
  /**
   * Map from engine name to a BackendProvider instance. Providers not
   * in the map are silently skipped (lets callers pass an incomplete
   * set during slice 5a when the WebView only has config_only wired).
   */
  providers: Partial<Record<BackendEngine, BackendProvider>>;
};

export type ResolverResult = {
  /**
   * The picked provider. null if none of the configured providers
   * reported available=true -- only possible if config_only isn't in
   * the tier list or its available() throws.
   */
  provider: BackendProvider | null;
  /**
   * Tier-by-tier probe trace -- useful for the failed-run banner and
   * the log-strings drift test.
   */
  attempts: ReadonlyArray<{
    engine: BackendEngine;
    available: boolean;
    /**
     * Set when a provider isn't in the providers map at all.
     */
    skipped?: boolean;
  }>;
};

export async function pickActiveBackendProvider(
  input: ResolverInput
): Promise<ResolverResult> {
  const attempts: Array<{
    engine: BackendEngine;
    available: boolean;
    skipped?: boolean;
  }> = [];

  for (const engine of input.tierList) {
    const candidate = input.providers[engine];
    if (!candidate) {
      attempts.push({ engine, available: false, skipped: true });
      continue;
    }
    try {
      const available = await candidate.available();
      attempts.push({ engine, available });
      if (available) {
        return { provider: candidate, attempts };
      }
    } catch {
      attempts.push({ engine, available: false });
    }
  }

  return { provider: null, attempts };
}
