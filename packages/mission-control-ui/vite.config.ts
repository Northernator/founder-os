import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * Builds the Mission Control UI as a SINGLE self-contained HTML file in
 * dist/index.html. Why single-file?
 *   - VS Code webviews don't have a stable URL scheme; serving multiple
 *     files means rewriting every <script> and <link> via webview.asWebviewUri.
 *     With one file, the extension host just reads dist/index.html and stuffs
 *     it into webview.html. Done.
 *   - No code-split chunks means no race between the protocol handshake and
 *     the React app being ready.
 *
 * Trade-off: the bundle is ~150-200 KB minified. Acceptable for a webview
 * that opens once per session.
 */
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    target: "es2022",
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
    // Don't minify in dev; minify in CI for size.
    minify: process.env.CI ? "esbuild" : false,
  },
});
