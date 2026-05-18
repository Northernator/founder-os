/**
 * Vitest config for @founder-os/research-deep-orchestrator.
 *
 * Tests live under test/. Node environment. All LLM calls + provider
 * I/O are dependency-injected, so tests just hand in fakes — no fetch,
 * no subprocess, no disk.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 5000,
  },
});
