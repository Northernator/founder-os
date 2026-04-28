# Packaging the Founder Cowork extension on Windows / PowerShell

This is the single doc for turning `apps/founder-cowork` into a `.vsix` you can sideload into your local VS Code.

## One-time setup

Install workspace deps from the repo root so `vsce` lands in `founder-cowork/node_modules/.bin` and so `node-pty`'s prebuilt binary gets fetched:

```powershell
cd D:\FOUNDER_AI\founder-os-fixed\founder-os
pnpm install
```

> `@vscode/vsce` is already listed as a devDependency on the extension, so you
> do **not** need `npm install -g @vscode/vsce`. pnpm resolves it locally.

> **node-pty must be in the root `package.json` `pnpm.onlyBuiltDependencies`**
> (it already is). Without that, pnpm 10 skips node-pty's postinstall and the
> platform `.node` binary is never produced. If you ever see `pty-loader.ts`
> complain that the binary is missing, run `pnpm install --force` from the
> repo root and re-check `pnpm.onlyBuiltDependencies`.

## Build the `.vsix`

From the repo root:

```powershell
pnpm --filter founder-cowork package
```

That runs in order:

1. `node esbuild.mjs` does two things:
   - **`copyNativeDeps()`** copies `node_modules/node-pty/{lib,build,package.json}` into `apps/founder-cowork/out/native/node-pty/`. Sidesteps pnpm's symlink forest and vsce's `--no-dependencies` flag in one move. The `.node` binary in `build/Release/` ships inside the VSIX.
   - **`esbuild.build`** bundles `src/extension.ts` (plus every `@founder-os/*` workspace package it imports) into `out/extension.js`. `node-pty` is marked `external`; runtime code loads it via `src/lib/pty-loader.ts` which resolves an absolute path to `out/native/node-pty/`.
2. `vsce package --no-dependencies --allow-missing-repository` packs `out/`, `package.json`, `README.md`, and `CHANGELOG.md` into `founder-cowork-X.Y.Z.vsix`.

Flag explainers:

- `--no-dependencies`: we use `workspace:*` deps which vsce cannot resolve against the npm registry. esbuild inlines the workspace deps, and `copyNativeDeps()` materializes the one native dep, so this flag is correct.
- `--allow-missing-repository`: skips the "this extension has no repository field" warning-as-error for local/internal builds. Remove this flag and fill in a real `repository.url` when publishing.

## What ships in the VSIX

After packaging, the extension contains:

```
extension/
  package.json
  README.md
  CHANGELOG.md
  images/icon.png
  out/
    extension.js               <- bundled by esbuild
    native/
      node-pty/
        package.json
        lib/                   <- JS entry points
        build/Release/
          pty.node             <- Windows ConPTY binary (~150 KB)
```

`.vscodeignore` excludes `**/*.ts` and `**/*.map` so we never ship sources or sourcemaps, but `.node` binaries pass through.

## Sideload into VS Code

```powershell
code --install-extension .\apps\founder-cowork\founder-cowork-0.3.0.vsix
```

Or via the UI: **Command Palette -> Extensions: Install from VSIX...** and pick the file.

## Publishing (later)

When you're ready for the Marketplace:

1. Create a publisher at <https://marketplace.visualstudio.com/manage>.
2. Update `package.json` -> `publisher` to match.
3. Replace `repository.url` with the real GitHub URL.
4. Get a Personal Access Token from Azure DevOps with **Marketplace (manage)** scope.
5. `vsce login <publisher>` -> paste the PAT.
6. `pnpm --filter founder-cowork package:ci` -> `vsce publish`.

> Note: the VSIX is currently single-platform (Windows ConPTY binary). For
> macOS/Linux distribution, either ship a per-platform VSIX
> (`vsce package --target win32-x64` etc) or copy all of node-pty's prebuilds
> into `out/native/`.

## Known warnings you can ignore

- **"The description is 100 characters long"**: vsce suggests <=80 for Marketplace discoverability. Not fatal.
- **"A 'LICENSE' file was not found"**: fine for private/internal. Add one before going public.
- **"Failed to detect badges"**: README has none. Normal.

## Troubleshooting

- **`vsce: command not found`**: you skipped `pnpm install`, or you're running from outside the workspace. `pnpm dlx @vscode/vsce package --no-dependencies` works as a one-off.
- **`node-pty failed to load from .../out/native/node-pty`**: re-run `pnpm install --force` from the repo root, then `pnpm --filter founder-cowork build`. Confirm `pty.node` exists at `apps/founder-cowork/out/native/node-pty/build/Release/pty.node`.
- **`copyNativeDeps: node-pty not found - skipping`**: `pnpm install` didn't put node-pty in any of the search paths. Verify `node-pty` is in `apps/founder-cowork/package.json` dependencies AND in root `package.json` `pnpm.onlyBuiltDependencies`.
- **`Icon is not a valid PNG`**: the icon at `images/icon.png` is the source-of-truth. If you swap it, keep it 128x128.
- **Extension activates but nothing happens**: check the `Founder Cowork` view in the activity bar, and the Output panel -> "founder-cowork" channel.
