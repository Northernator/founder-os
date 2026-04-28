/**
 * File-backed LRU cache backend for prompt-master.
 *
 * NODE-ONLY. Imports node:fs/promises etc directly. Must never be pulled into
 * a browser bundle. Reach this module via:
 *   import { installFsCacheBackend } from "@founder-os/prompt-master/node";
 *
 * Why disk: the cache must survive process restarts. CLI scripts run once,
 * build steps spawn fresh Node processes — an in-memory cache would be
 * useless for the access patterns Node consumers actually have.
 *
 * Layout: $PROMPT_MASTER_CACHE_DIR/<first-2-of-hash>/<rest-of-hash>.json
 * The first-2 sharding keeps any single directory under ~256 entries even
 * with millions of cached prompts.
 *
 * Eviction: LRU with a configurable byte cap (default 200 MB). Tracked via
 * an index file at $CACHE_DIR/_index.json updated on each write. Eviction
 * runs opportunistically when writes detect we're over budget — no
 * background sweeper to keep things simple.
 */
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type CacheBackend, type CacheStats, type CachedEntry, setCacheBackend } from "./cache.js";

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024; // 200 MB
const INDEX_FILE = "_index.json";

interface IndexEntry {
  hash: string;
  bytes: number;
  lastUsed: string; // ISO — drives LRU
}

interface CacheIndex {
  totalBytes: number;
  entries: IndexEntry[];
}

function cacheDir(): string {
  return (
    process.env.PROMPT_MASTER_CACHE_DIR ?? join(homedir(), ".founder-os", "cache", "prompt-master")
  );
}

function maxBytes(): number {
  const env = process.env.PROMPT_MASTER_CACHE_MAX_BYTES;
  return env ? Number.parseInt(env, 10) : DEFAULT_MAX_BYTES;
}

function pathFor(hash: string): string {
  return join(cacheDir(), hash.slice(0, 2), hash.slice(2) + ".json");
}

function indexPath(): string {
  return join(cacheDir(), INDEX_FILE);
}

async function readIndex(): Promise<CacheIndex> {
  try {
    const raw = await readFile(indexPath(), "utf8");
    return JSON.parse(raw) as CacheIndex;
  } catch {
    return { totalBytes: 0, entries: [] };
  }
}

async function writeIndex(index: CacheIndex): Promise<void> {
  await mkdir(dirname(indexPath()), { recursive: true });
  await writeFile(indexPath(), JSON.stringify(index), "utf8");
}

async function touchIndex(hash: string): Promise<void> {
  const index = await readIndex();
  const found = index.entries.find((e) => e.hash === hash);
  if (found) {
    found.lastUsed = new Date().toISOString();
    await writeIndex(index);
  }
}

async function evictIfNeeded(index: CacheIndex): Promise<void> {
  const cap = maxBytes();
  if (index.totalBytes <= cap) return;

  // Evict least-recently-used until under cap.
  index.entries.sort((a, b) => a.lastUsed.localeCompare(b.lastUsed));
  while (index.totalBytes > cap && index.entries.length > 0) {
    const victim = index.entries.shift()!;
    try {
      await unlink(pathFor(victim.hash));
    } catch {
      // File already gone — ignore.
    }
    index.totalBytes -= victim.bytes;
  }
}

class FsCacheBackend implements CacheBackend {
  async get(hash: string): Promise<CachedEntry | null> {
    try {
      const raw = await readFile(pathFor(hash), "utf8");
      const entry = JSON.parse(raw) as CachedEntry;
      await touchIndex(hash);
      return entry;
    } catch {
      return null;
    }
  }

  async put(hash: string, entry: CachedEntry): Promise<void> {
    const file = pathFor(hash);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(entry), "utf8");

    const index = await readIndex();
    const existing = index.entries.find((e) => e.hash === hash);
    if (existing) {
      index.totalBytes -= existing.bytes;
      existing.bytes = entry.bytes;
      existing.lastUsed = entry.storedAt;
      index.totalBytes += entry.bytes;
    } else {
      index.entries.push({ hash, bytes: entry.bytes, lastUsed: entry.storedAt });
      index.totalBytes += entry.bytes;
    }

    await evictIfNeeded(index);
    await writeIndex(index);
  }

  async inspect(): Promise<CacheStats> {
    const index = await readIndex();
    return {
      entries: index.entries.length,
      totalBytes: index.totalBytes,
      capBytes: maxBytes(),
    };
  }
}

/**
 * Install the disk-backed cache as the active backend. Idempotent — calling
 * twice replaces the backend with a fresh instance (which is fine; the
 * underlying files are the source of truth, not the in-memory wrapper).
 *
 * Call once at Node startup, before any optimize() calls. Required if you
 * want cache persistence across process restarts.
 */
export function installFsCacheBackend(): void {
  setCacheBackend(new FsCacheBackend());
}
