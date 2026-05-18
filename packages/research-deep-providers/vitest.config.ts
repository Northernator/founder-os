/**
 * Vitest config for @founder-os/research-deep-providers.
 *
 * Tests live under test/. Node environment. Subprocess spawn is mocked
 * via vi.mock("node:child_process") so tests never shell out to
 * gemini-cli / claude.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 5000,
  },
});
