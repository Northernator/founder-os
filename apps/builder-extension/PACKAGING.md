# Packaging the Builder extension on Windows / PowerShell

Chris — this is the single doc for turning `apps/builder-extension` into a `.vsix` you can sideload into your local VS Code.

## One-time setup

Install workspace deps from the repo root so `vsce` lands in `builder-extension/node_modules/.bin`:

```powershell
cd C:\path\to\founder-os
pnpm install
```

> `@vscode/vsce` is already listed as a devDependency on the extension, so you
> do **not** need `npm install -g @vscode/vsce`. pnpm resolves it locally.

## Build the `.vsix`

From the repo root:

```powershell
pnpm --filter founder-os-builder package
```

That runs in order:

1. `esbuild` bundles `src/extension.ts` (plus every `@founder-os/*` workspace package it imports) into `out/extension.js`.
2. `vsce package --no-dependencies --allow-missing-repository` packs the bundle + `package.json` + `README.md` + `CHANGELOG.md` into `founder-os-builder-0.1.0.vsix`.

Flags explained:

- `--no-dependencies` — we use `workspace:*` deps, which vsce cannot resolve against the npm registry. esbuild inlines them anyway, so this flag is correct.
- `--allow-missing-repository` — skips the "this extension has no repository field" warning-as-error for local/internal builds. Remove this flag and fill in a real `repository.url` when publishing.

## Sideload into VS Code

```powershell
code --install-extension .\apps\builder-extension\founder-os-builder-0.1.0.vsix
```

Or via the UI: **Command Palette → Extensions: Install from VSIX…** and pick the file.

## Publishing (later)

When you're ready for the Marketplace:

1. Create a publisher at <https://marketplace.visualstudio.com/manage>.
2. Update `package.json` → `publisher` to match.
3. Replace `repository.url` with the real GitHub URL.
4. Get a Personal Access Token from Azure DevOps with **Marketplace (manage)** scope.
5. `vsce login <publisher>` → paste the PAT.
6. `pnpm --filter founder-os-builder package:ci` → `vsce publish`.

## Known warnings you can ignore

- **"The description is 100 characters long"** — vsce suggests ≤80 for Marketplace discoverability. Not fatal.
- **"A 'LICENSE' file was not found"** — fine for private/internal. Add one before going public.
- **"Failed to detect badges"** — README has none. Normal.

## Troubleshooting

- **`vsce: command not found`** — you skipped `pnpm install`, or you're running from outside the workspace. `pnpm dlx @vscode/vsce package --no-dependencies` works as a one-off.
- **`Icon is not a valid PNG`** — we don't ship an icon yet. If you add one, drop a 128×128 PNG at `apps/builder-extension/icon.png` and add `"icon": "icon.png"` to `package.json`.
- **Extension activates but nothing happens** — check the `Founder OS` view in the activity bar, and the Output panel → "Founder OS Builder" channel.
