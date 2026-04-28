/**
 * Cache facade for optimized prompts.
 *
 * Browser-safe: this module never imports node:* modules. Default backend is
 * an in-memory Map, which is fine for the Tauri WebView (cache survives the
 * window's lifetime; we don't try to persist across reloads from the client).
 *
 * Node consumers (CLIs, VS Code extensions, build scripts) should call
 * `installFsCacheBackend()` from "@founder-os/prompt-master/node" at startup
 * to upgrade to the disk-backed LRU cache that survives process restarts.
 *
 * Why a backend indirection: the core dispatcher (`optimize`) calls
 * getCached/putCached on every request. Having one call site that swaps
 * implementations at startup keeps `optimize` runtime-agnostic and avoids
 * the bundler dragging Node-only code into the client.
 */

export interface CachedEntry {
  optimized: string;
  storedAt: string; // ISO
  bytes: number;
}

export interface CacheStats {
  entries: number;
  totalBytes: number;
  capBytes: number;
}

export interface CacheBackend {
  get(hash: string): Promise<CachedEntry | null>;
  put(hash: string, entry: CachedEntry): Promise<void>;
  inspect(): Promise<CacheStats>;
}

class MemoryCacheBackend implements CacheBackend {
  private map = new Map<string, CachedEntry>();
  async get(hash: string): Promise<CachedEntry | null> {
    return this.map.get(hash) ?? null;
  }
  async put(hash: string, entry: CachedEntry): Promise<void> {
    this.map.set(hash, entry);
  }
  async inspect(): Promise<CacheStats> {
    let totalBytes = 0;
    for (const e of this.map.values()) totalBytes += e.bytes;
    return { entries: this.map.size, totalBytes, capBytes: 0 };
  }
}

let backend: CacheBackend = new MemoryCacheBackend();

/**
 * Replace the active cache backend. Node consumers wire this at startup to
 * the file-based implementation; the in-memory default is what the browser
 * and other runtimes use.
 */
export function setCacheBackend(impl: CacheBackend): void {
  backend = impl;
}

export function getCacheBackend(): CacheBackend {
  return backend;
}

export async function getCached(hash: string): Promise<CachedEntry | null> {
  return backend.get(hash);
}

export async function putCached(hash: string, optimized: string): Promise<void> {
  // Byte length is computed off the UTF-8 string. Web-safe: TextEncoder is
  // always available where this module runs.
  const bytes = new TextEncoder().encode(optimized).byteLength;
  await backend.put(hash, {
    optimized,
    storedAt: new Date().toISOString(),
    bytes,
  });
}

export async function inspectCache(): Promise<CacheStats> {
  return backend.inspect();
}
