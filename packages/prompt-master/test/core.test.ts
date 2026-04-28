/**
 * Smoke tests for the optimizer.
 *
 * Run via:  pnpm -F @founder-os/prompt-master test
 *
 * Covers:
 *   - Null transport returns input unchanged with fallbackUsed=true
 *   - A real transport's result gets cached
 *   - A second call with the same inputs hits cache (cacheHit=true)
 *   - Transport errors don't throw, set fallbackUsed=true
 *   - Lossless guarantee: when transport returns the same string, no harm
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set cache + log dirs to a fresh temp location BEFORE installing the FS
// backends. The dirs are read at backend-install time, not at module load.
const tempDir = await mkdtemp(join(tmpdir(), "pm-test-"));
process.env.PROMPT_MASTER_CACHE_DIR = join(tempDir, "cache");
process.env.PROMPT_MASTER_LOG_DIR = join(tempDir, "log");

const { optimize, setTransport, resetTransport, asTransport } = await import("../src/index.js");
const { installNodeBackends } = await import("../src/node.js");

// Tests rely on disk persistence between optimize() calls — install the FS
// backends so we exercise the same code path the CLI and extensions use.
installNodeBackends();

async function run(): Promise<void> {
  // 1. Null transport — input unchanged, fallback flag set.
  resetTransport();
  const r1 = await optimize({ prompt: "Hello world", context: "other" });
  assert.equal(r1.optimized, "Hello world");
  assert.equal(r1.fallbackUsed, true);
  assert.equal(r1.cacheHit, false);
  assert.equal(r1.tokensSaved, 0);
  console.log("ok 1: null transport pass-through");

  // 2. Real transport — caches the result.
  setTransport(
    asTransport("test-shorten", async (input) => ({
      optimized: input.prompt.slice(0, Math.floor(input.prompt.length / 2)),
    }))
  );
  const long = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.";
  const r2 = await optimize({ prompt: long, context: "system" });
  assert.equal(r2.fallbackUsed, false);
  assert.equal(r2.cacheHit, false);
  assert.ok(r2.optimized.length < long.length, "expected shorter output");
  assert.ok(r2.tokensSaved > 0, "expected positive tokensSaved");
  console.log("ok 2: real transport optimizes + caches");

  // 3. Second call — same inputs, cache hit.
  const r3 = await optimize({ prompt: long, context: "system" });
  assert.equal(r3.cacheHit, true, "expected cache hit on second identical call");
  assert.equal(r3.optimized, r2.optimized, "cache returned different value");
  console.log("ok 3: cache hit on identical inputs");

  // 4. Transport error — fallback, no throw.
  setTransport(
    asTransport("test-broken", async () => {
      throw new Error("upstream down");
    })
  );
  const r4 = await optimize({ prompt: "Different prompt entirely", context: "research" });
  assert.equal(r4.fallbackUsed, true);
  assert.equal(r4.optimized, "Different prompt entirely");
  console.log("ok 4: transport error falls back without throwing");

  // 5. Lossless: identity transport (returns input as-is) should not poison cache.
  resetTransport();
  setTransport(asTransport("identity", async (input) => ({ optimized: input.prompt })));
  const r5 = await optimize({ prompt: "Identity prompt", context: "audit" });
  assert.equal(r5.fallbackUsed, true, "identity transport should be marked as pass-through");
  console.log("ok 5: identity transport flagged as fallback (no cache pollution)");

  await rm(tempDir, { recursive: true, force: true });
  console.log("\nall tests passed");
}

run().catch((err) => {
  console.error("test failed:", err);
  process.exit(1);
});
