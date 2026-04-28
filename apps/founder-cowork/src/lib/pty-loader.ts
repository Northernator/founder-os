/**
 * Runtime loader for node-pty.
 *
 * node-pty ships platform-specific .node binaries (Win32 ConPTY, *nix forkpty).
 * esbuild can't bundle those, so esbuild.mjs copies the package into
 * out/native/node-pty/ at build time and we resolve from there at runtime.
 *
 * Why not `import * as pty from "node-pty"`?
 *   - In dev: works (resolves via node_modules).
 *   - In packaged VSIX: fails — `--no-dependencies` strips node_modules.
 * Resolving via an absolute __dirname-relative path keeps both paths working.
 *
 * If you change packaging, the only knob is OUT_NATIVE_REL below.
 */

import * as path from "node:path";

/** Path to out/native/node-pty/ relative to the bundled extension.js. */
const OUT_NATIVE_REL = "native/node-pty";

let cached: typeof import("node-pty") | null = null;

/**
 * Lazily load node-pty. Throws a friendly error if the prebuilt binary is
 * missing (e.g. someone forgot to run the build, or the VSIX was packaged
 * without the native copy step).
 */
export function loadNodePty(): typeof import("node-pty") {
  if (cached) return cached;

  // __dirname after esbuild bundling = .../out/
  const ptyPath = path.join(__dirname, OUT_NATIVE_REL);

  try {
    // Use require so esbuild leaves it alone (it's marked external).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(ptyPath) as typeof import("node-pty");
    cached = mod;
    return mod;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      "Founder Cowork: node-pty failed to load from " + ptyPath + ".\n\n" +
        "Likely causes:\n" +
        "  • The build step didn't copy native deps. Run `pnpm --filter founder-cowork build`.\n" +
        "  • node-pty's prebuilt binary is missing. From the repo root run:\n" +
        "      pnpm install --force\n" +
        "    and check that `node-pty` is listed in pnpm.onlyBuiltDependencies.\n" +
        "  • The VSIX was packaged before out/native/ existed. Re-run `pnpm --filter founder-cowork package`.\n\n" +
        "Underlying error: " + msg,
    );
  }
}
