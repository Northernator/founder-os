/**
 * Content-hash dedupe used both within a single job (the user dropped the
 * same file twice) and across jobs (the user imports the same PDF six
 * months later -- we reuse the cached extraction).
 *
 * Pure -- the storage port (KnownHashStore) is injected so unit tests
 * stub it with a Map.
 */

export interface KnownHashStore {
  /** True if the hash has been seen by any prior or in-progress job. */
  has(hash: string): Promise<boolean> | boolean;
  /** Mark a hash as observed. Idempotent. */
  add(hash: string): Promise<void> | void;
}

export interface DedupeInput<T> {
  /** Candidate items that already have their content hash computed. */
  items: ReadonlyArray<T & { contentHash: string }>;
  store: KnownHashStore;
}

export interface DedupeResult<T> {
  fresh: Array<T & { contentHash: string }>;
  duplicates: Array<T & { contentHash: string }>;
}

/**
 * In-memory dedupe + persistent dedupe in one pass.
 *
 * Items inside this batch with the same hash collapse to one (the first
 * occurrence wins; the rest go to `duplicates`). Items whose hash is
 * already in the persistent store also go to `duplicates`.
 */
export async function dedupeByHash<T>(input: DedupeInput<T>): Promise<DedupeResult<T>> {
  const fresh: Array<T & { contentHash: string }> = [];
  const duplicates: Array<T & { contentHash: string }> = [];
  const seenInBatch = new Set<string>();
  for (const item of input.items) {
    if (seenInBatch.has(item.contentHash)) {
      duplicates.push(item);
      continue;
    }
    if (await input.store.has(item.contentHash)) {
      seenInBatch.add(item.contentHash);
      duplicates.push(item);
      continue;
    }
    seenInBatch.add(item.contentHash);
    fresh.push(item);
    await input.store.add(item.contentHash);
  }
  return { fresh, duplicates };
}

/** Convenience in-memory store -- used by tests + the renderer preview. */
export function createInMemoryHashStore(seed: Iterable<string> = []): KnownHashStore {
  const inner = new Set<string>(seed);
  return {
    has: (h) => inner.has(h),
    add: (h) => {
      inner.add(h);
    },
  };
}
