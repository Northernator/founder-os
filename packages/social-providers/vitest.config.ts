/**
 * Vitest config for @founder-os/social-providers.
 *
 * Tests live under test/. Node environment. Subprocess spawn + fetch
 * are mocked via injected impls (SpawnLike / FetchLike) so tests never
 * shell out or touch the network.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 5000,
  },
});
