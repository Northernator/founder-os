/**
 * Vitest config for @founder-os/handoff-pack-providers.
 *
 * Tests live under test/. Node environment because the Node-only
 * code paths (prepareBrandAssetsStep, renderPdfStep) use node:fs.
 * Filesystem operations target tmp directories scoped to each test;
 * nothing escapes the package boundary.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 5000,
  },
});
