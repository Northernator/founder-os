import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  external: [
    "vscode",          // VS Code API — provided by the extension host
    "node:*",          // Node built-ins
    "fs", "path", "os", "crypto", "util", "stream", "events",
  ],
  format: "cjs",       // VS Code extensions must be CommonJS
  platform: "node",
  target: "node20",
  sourcemap: true,
  logLevel: "info",
  // Resolve workspace packages from their source
  plugins: [],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("Watching for changes…");
} else {
  await esbuild.build(options);
  console.log("Build complete → out/extension.js");
}
