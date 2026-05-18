/**
 * Vitest config for @founder-os/handoff-providers.
 *
 * Tests live under test/. Node environment. Subprocess spawn is mocked
 * via vi.mock("node:child_process") so tests never shell out.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 5000,
  },
});
