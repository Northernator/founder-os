/**
 * Vitest config for @founder-os/stage-runners.
 *
 * Tests live under test/. Node environment (no UI). Each test wires
 * its own InMemoryFs adapter from test/_helpers/in-memory-fs.ts so
 * runs don't touch the real filesystem.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 5000,
  },
});
