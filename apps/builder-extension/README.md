# Founder OS Builder

VS Code extension that receives handoff bundles from the [Founder OS Desktop](../founder-desktop) app and executes AI-driven code generation inside a venture's repo.

## What it does

The Desktop app runs a pipeline that produces a brand brief, design tokens, a build handoff, and audit findings for a venture. This extension picks up the handoff bundle and:

- Watches the venture's `inbox/` folder for new bundles
- Expands them into scaffolded source files
- Invokes Claude (or an OpenAI-compatible endpoint) to fill in implementations
- Surfaces build status in a dedicated activity-bar view

## Install (sideload)

1. Build the `.vsix`:
   ```bash
   pnpm --filter founder-os-builder build
   pnpm --filter founder-os-builder package
   ```
2. Install it into VS Code:
   - **Command Palette** → `Extensions: Install from VSIX…`
   - Pick `founder-os-builder-0.1.0.vsix`

## Configuration

Set the following under **Settings → Extensions → Founder OS**:

| Setting | Purpose |
| --- | --- |
| `founderOs.ventureRoot` | Absolute path to the venture workspace root (matches what you selected in the Desktop app) |
| `founderOs.anthropicApiKey` | Claude API key used for code generation |
| `founderOs.model` | Claude model name (default: `claude-opus-4-6`) |
| `founderOs.autoWatch` | If `true`, start watching `inbox/` on activation |

> API key tip: the Desktop app stores its keys in the OS keychain. This
> extension uses VS Code's own settings store, which is separate. Paste
> the key into both if you're using both apps.

## Commands

All available via the Command Palette:

- `Founder OS: Select Venture Folder`
- `Founder OS: Run Pipeline`
- `Founder OS: Accept Handoff Bundle`
- `Founder OS: Show Status`

## Development

```bash
# rebuild on save
pnpm --filter founder-os-builder watch

# typecheck
pnpm --filter founder-os-builder typecheck
```

Open the `apps/builder-extension/` folder in a separate VS Code window and hit `F5` to launch a Dev Host with the extension loaded.
