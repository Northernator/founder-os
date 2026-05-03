/**
 * Vitest config for @founder-os/sales-agents.
 *
 * Tests live under test/. Node environment (we are not testing UI).
 * No setup file needed -- agents take all their I/O via injected
 * adapters, so each test wires its own fakes inline.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 5000,
  },
});
