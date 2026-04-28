import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

/**
 * Native deps that can't be bundled by esbuild (they ship platform-specific
 * .node binaries). For each of these we:
 *   1. mark the package as `external` so esbuild leaves require("X") alone
 *   2. copy the package's runtime files into out/native/<pkg>/ at build time
 *   3. resolve them at runtime via lib/pty-loader.ts (absolute __dirname path)
 */
const NATIVE_DEPS = ["node-pty"];

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  external: [
    "vscode",
    "node:*",
    "fs",
    "path",
    "os",
    "crypto",
    "util",
    "stream",
    "events",
    ...NATIVE_DEPS,
  ],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  logLevel: "info",
  plugins: [],
};

/**
 * Copy native deps into out/native/<pkg>/. Then ensure build/Release/<pkg>.node
 * is present - node-pty 1.x defers to a postinstall to extract the right
 * prebuild from prebuilds/<platform>-<arch>/node.napi.node. pnpm 10 sometimes
 * skips that script (security feature, gated by onlyBuiltDependencies). We
 * defensively re-do that step here if needed.
 */
function copyNativeDeps() {
  const projectRoot = __dirname;
  const outDir = path.join(projectRoot, "out", "native");
  fs.mkdirSync(outDir, { recursive: true });

  for (const dep of NATIVE_DEPS) {
    const candidates = [
      path.join(projectRoot, "node_modules", dep),
      path.join(projectRoot, "..", "..", "node_modules", dep),
    ];
    let src = null;
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        src = fs.realpathSync(c);
        break;
      }
    }
    if (!src) {
      console.warn(
        "[copyNativeDeps] " +
          dep +
          " not found - skipping. " +
          "Run `pnpm install` from the repo root and ensure " +
          dep +
          " is in pnpm.onlyBuiltDependencies."
      );
      continue;
    }
    const dest = path.join(outDir, dep);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, {
      recursive: true,
      filter: (s) => !s.replace(src, "").split(path.sep).includes("node_modules"),
    });

    // node-pty's runtime require("./build/Release/pty.node"). On a clean
    // pnpm 10 install where postinstall didn't run, that file's missing
    // but prebuilds/<platform>-<arch>/node.napi.node IS shipped. Materialise
    // it here so the runtime require succeeds regardless.
    if (dep === "node-pty") {
      ensureNodePtyBuildRelease(dest);
    }

    const releaseDir = path.join(dest, "build", "Release");
    if (fs.existsSync(releaseDir)) {
      const binaries = fs.readdirSync(releaseDir).filter((f) => f.endsWith(".node"));
      console.log(
        "[copyNativeDeps] " +
          dep +
          ": " +
          binaries.length +
          " prebuilt binary(ies) - " +
          (binaries.join(", ") || "(none)")
      );
    } else {
      console.warn(
        "[copyNativeDeps] " +
          dep +
          ": no build/Release/ directory found AND no prebuild matched. " +
          "The extension will fail to load node-pty at runtime. Try " +
          "`pnpm install --force` from the repo root."
      );
    }
  }
}

function ensureNodePtyBuildRelease(destPkg) {
  const releaseDir = path.join(destPkg, "build", "Release");
  // Already populated by a prior postinstall? Done.
  if (fs.existsSync(releaseDir) && fs.readdirSync(releaseDir).some((f) => f.endsWith(".node"))) {
    return;
  }

  // Look for a matching prebuild. Folder naming on node-pty 1.x:
  //   prebuilds/<platform>-<arch>/node.napi.node
  //   e.g. prebuilds/win32-x64/node.napi.node
  const prebuildsDir = path.join(destPkg, "prebuilds");
  if (!fs.existsSync(prebuildsDir)) return;

  const target = process.platform + "-" + process.arch;
  const candidate = path.join(prebuildsDir, target);
  let chosen = null;
  if (fs.existsSync(candidate)) {
    const node = fs.readdirSync(candidate).find((f) => f.endsWith(".node"));
    if (node) chosen = path.join(candidate, node);
  }
  if (!chosen) {
    // Last-resort scan: any .node anywhere under prebuilds/ that contains
    // our platform string. node-pty's `node-gyp-build` resolver does
    // similar fuzzy matching at runtime; we mirror it here.
    const stack = [prebuildsDir];
    while (stack.length && !chosen) {
      const dir = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (p.includes(process.platform) || p.includes(process.arch)) {
            stack.push(p);
          }
          continue;
        }
        if (
          e.isFile() &&
          e.name.endsWith(".node") &&
          (dir.includes(process.platform) || dir.includes(process.arch))
        ) {
          chosen = p;
          break;
        }
      }
    }
  }
  if (!chosen) {
    console.warn("[copyNativeDeps] node-pty: no prebuild for " + target + " under " + prebuildsDir);
    return;
  }

  fs.mkdirSync(releaseDir, { recursive: true });
  fs.copyFileSync(chosen, path.join(releaseDir, "pty.node"));
  console.log(
    "[copyNativeDeps] node-pty: materialised " +
      path.relative(destPkg, chosen) +
      " -> build/Release/pty.node"
  );
}

/**
 * Build the @founder-os/mission-control-ui (Vite + React) and copy its
 * single-file dist into out/ui/.
 *
 * Windows quirk: `cp.spawnSync` on Windows can't resolve .cmd shims
 * without `shell: true`, so the prior implementation died with exit=null.
 */
function buildAndCopyUi() {
  const projectRoot = __dirname;
  const uiPkg = path.join(projectRoot, "..", "..", "packages", "mission-control-ui");
  const uiDist = path.join(uiPkg, "dist");
  const outUi = path.join(projectRoot, "out", "ui");

  if (!fs.existsSync(uiPkg)) {
    console.warn("[buildUi] mission-control-ui package not found at " + uiPkg);
    return;
  }

  const isWin = process.platform === "win32";
  console.log("[buildUi] running `pnpm --filter @founder-os/mission-control-ui build`...");
  const result = cp.spawnSync("pnpm", ["--filter", "@founder-os/mission-control-ui", "build"], {
    cwd: path.join(projectRoot, "..", ".."),
    stdio: "inherit",
    shell: isWin, // critical on Windows so .cmd shims resolve
  });
  if (result.status !== 0) {
    console.error(
      "[buildUi] vite build failed (exit " +
        result.status +
        ")" +
        (result.error ? " :: " + String(result.error) : "")
    );
    return;
  }

  if (!fs.existsSync(uiDist)) {
    console.warn("[buildUi] vite produced no dist/ at " + uiDist);
    return;
  }

  fs.rmSync(outUi, { recursive: true, force: true });
  fs.cpSync(uiDist, outUi, { recursive: true });
  const indexExists = fs.existsSync(path.join(outUi, "index.html"));
  console.log(
    "[buildUi] copied dist/ -> out/ui/" + (indexExists ? " (index.html OK)" : " (NO index.html!)")
  );
}

if (watch) {
  copyNativeDeps();
  buildAndCopyUi();
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  copyNativeDeps();
  buildAndCopyUi();
  await esbuild.build(options);
  console.log("Build complete -> out/extension.js");
}
