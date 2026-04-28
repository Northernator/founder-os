import type { CacheBackend, CacheStats, CachedEntry } from "@founder-os/prompt-master";
/**
 * Tauri-backed CacheBackend for @founder-os/prompt-master.
 *
 * The default cache backend is an in-memory Map — fine for short-lived
 * sessions but the cache is lost the moment the user closes the window.
 * This implementation persists across restarts by routing get/put/inspect
 * through three Tauri commands implemented in src-tauri/src/cache.rs:
 *
 *   pm_cache_get(hash)             →  CachedEntry | null
 *   pm_cache_put(hash, entry)      →  void
 *   pm_cache_inspect()             →  CacheStats
 *
 * The Rust side stores rows in `prompt_master_cache` (migration 0007)
 * and runs LRU eviction inside `pm_cache_put` when the total exceeds
 * 200MB. We don't talk to disk directly — the WebView can't import
 * node:* and biome.json forbids it anyway.
 *
 * Failure mode: cache faults must NEVER break optimize(). On any invoke
 * error we log + return null/undefined so the dispatcher falls through
 * to the transport. Returning a partial CacheStats from inspect()
 * matches the same defensive contract.
 */
import { invoke } from "@tauri-apps/api/core";

/** Wire payload for pm_cache_get. Field names match Rust's serde
 *  rename_all = "camelCase" so they line up with CachedEntry. */
type GetResponse = CachedEntry | null;

/** Wire payload for pm_cache_inspect. */
type InspectResponse = CacheStats;

/** When the Rust command rejects, we never propagate — the caller is
 *  the prompt-master core dispatcher and a thrown error inside get()
 *  would surface as an "optimize failed" telemetry event even though
 *  the optimizer itself was never reached. Logging once per failure
 *  type keeps DevTools useful without flooding the console. */
function logCacheFault(op: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[prompt-master] tauri cache ${op} failed (will fall through)`, message);
}

export function createTauriCacheBackend(): CacheBackend {
  return {
    async get(hash: string): Promise<CachedEntry | null> {
      try {
        const res = await invoke<GetResponse>("pm_cache_get", { hash });
        return res ?? null;
      } catch (err) {
        logCacheFault("get", err);
        return null;
      }
    },

    async put(hash: string, entry: CachedEntry): Promise<void> {
      try {
        await invoke<void>("pm_cache_put", {
          hash,
          optimized: entry.optimized,
          storedAt: entry.storedAt,
          bytes: entry.bytes,
        });
      } catch (err) {
        logCacheFault("put", err);
        // Swallow — a missed write just means the next session re-runs
        // the optimizer for this hash. No correctness impact.
      }
    },

    async inspect(): Promise<CacheStats> {
      try {
        return await invoke<InspectResponse>("pm_cache_inspect");
      } catch (err) {
        logCacheFault("inspect", err);
        // Defensive zeroes — callers (debug panel, telemetry) treat
        // these as "cache empty / unknown size" rather than erroring.
        return { entries: 0, totalBytes: 0, capBytes: 0 };
      }
    },
  };
}
