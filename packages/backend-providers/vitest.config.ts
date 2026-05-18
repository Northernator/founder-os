/**
 * Vitest config for @founder-os/backend-providers.
 *
 * Tests live under test/. Node environment. Subprocess spawn + fetch
 * are mocked via vi.fn() / injected impls so tests never shell out or
 * touch the network.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 5000,
  },
});
