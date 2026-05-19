import { describe, expect, it } from "vitest";
import { createInMemoryHashStore, dedupeByHash } from "../src/dedupe";

describe("dedupeByHash", () => {
  it("collapses duplicates within a single batch", async () => {
    const store = createInMemoryHashStore();
    const items = [
      { name: "a.pdf", contentHash: "hash-a" },
      { name: "a-copy.pdf", contentHash: "hash-a" },
      { name: "b.pdf", contentHash: "hash-b" },
    ];
    const result = await dedupeByHash({ items, store });
    expect(result.fresh.map((f) => f.name)).toEqual(["a.pdf", "b.pdf"]);
    expect(result.duplicates.map((d) => d.name)).toEqual(["a-copy.pdf"]);
  });

  it("treats hashes already in the store as duplicates", async () => {
    const store = createInMemoryHashStore(["hash-existing"]);
    const items = [
      { name: "new.pdf", contentHash: "hash-new" },
      { name: "stale.pdf", contentHash: "hash-existing" },
    ];
    const result = await dedupeByHash({ items, store });
    expect(result.fresh.map((f) => f.name)).toEqual(["new.pdf"]);
    expect(result.duplicates.map((d) => d.name)).toEqual(["stale.pdf"]);
  });

  it("adds fresh hashes to the store", async () => {
    const store = createInMemoryHashStore();
    const items = [{ name: "x.pdf", contentHash: "x" }];
    await dedupeByHash({ items, store });
    expect(await store.has("x")).toBe(true);
  });

  it("returns empty arrays for empty input", async () => {
    const store = createInMemoryHashStore();
    const result = await dedupeByHash({ items: [], store });
    expect(result.fresh).toEqual([]);
    expect(result.duplicates).toEqual([]);
  });
});
