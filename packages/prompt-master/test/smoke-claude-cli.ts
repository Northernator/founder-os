/**
 * Smoke test: confirm the claude-cli transport works end-to-end.
 *
 * Run: pnpm -F @founder-os/prompt-master exec tsx test/smoke-claude-cli.ts
 *
 * Prereqs:
 *   - `claude` CLI on PATH
 *   - logged in via `claude login` (one-time)
 *
 * If the binary isn't installed or you're not logged in, you'll see
 * fallbackUsed=true and the prompt comes back unchanged - that's the
 * graceful-degradation guarantee, not a test failure.
 */
import { optimize, setTransport } from "../src/index.js";
import { createClaudeCliTransport, installNodeBackends } from "../src/node.js";

installNodeBackends();

const SAMPLE_PROMPT =
  "You are an assistant. Please make sure to be very thorough and complete in your responses, ensuring that you cover all the bases. Always do your best to provide accurate and helpful information.";

setTransport(
  createClaudeCliTransport({
    binary: "claude",
    extraArgs: ["--model", "claude-haiku-4-5-20251001"],
  })
);

console.log("Calling optimize() through claude-cli transport...");
const result = await optimize({
  prompt: SAMPLE_PROMPT,
  context: "system",
});

console.log("");
console.log("Original prompt:");
console.log(`  ${SAMPLE_PROMPT}`);
console.log("");
console.log("Optimized:");
console.log(`  ${result.optimized}`);
console.log("");
console.log(`Tokens saved (estimate): ${result.tokensSaved}`);
console.log(`Cache hit:               ${result.cacheHit}`);
console.log(`Fallback used:           ${result.fallbackUsed}`);
console.log(`Transport:               ${result.trace.transport}`);
console.log(`Latency (ms):            ${result.trace.latencyMs}`);

if (result.fallbackUsed) {
  console.log("");
  console.log("[fallback] Either claude binary not on PATH, not logged in,");
  console.log("           or CLI flags differ. Run `claude --version` and");
  console.log("           `claude --help` to verify.");
  process.exit(1);
}
