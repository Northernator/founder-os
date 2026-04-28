# Changelog

All notable changes to the Founder Cowork extension are recorded here.

## [0.3.0] - 2026-04-24

Phase 1a complete - foundation for the multi-agent rewrite. Replaces the
Windows-broken `.ps1` runner from `multi-agent-cowork-extension@0.4.0` with
a real PTY-based agent host.

### Added
- **node-pty integration**. Sessions spawn into a real pseudo-terminal
  (Windows ConPTY on Win10+, forkpty on *nix). No more PowerShell
  `ExecutionPolicy` failures or temp `.ps1` files.
- **`packages/agent-runner`** (new workspace package) - `AgentRunner` class
  with dependency-injected pty loader. Builds argv per agent's
  `promptInjection` mode (`argv` / `flag-prompt` / `stdin`); rejects `http`
  agents with a clear error.
- **`apps/founder-cowork/src/lib/pty-loader.ts`** - resolves node-pty from
  `out/native/node-pty/` so the same code works in dev (node_modules) and
  in the packaged VSIX (where `--no-dependencies` strips node_modules).
- **`apps/founder-cowork/src/lib/session-terminal.ts`** - wraps an
  `AgentSession` in a `vscode.Pseudoterminal` so PTY output appears in a
  real terminal pane with scrollback, copy/paste, and ANSI colors. Forwards
  keystrokes and resize events back to the PTY.
- **`copyNativeDeps()` build step** in `esbuild.mjs` - copies
  `node_modules/node-pty/{lib,build,package.json}` into
  `out/native/node-pty/` at build time so the platform `.node` binary ships
  with the VSIX without fighting pnpm's symlink forest.
- All 5 commands wired: `openMissionControl`, `newSession` (Ctrl+Shift+A),
  `orchestrate` (Ctrl+Shift+O), `showSession`, `killSession`. Plus
  `pickVentureRoot` and `showStatus`.
- Preflight health check on activation - probes each agent binary on PATH
  via `where`/`which` and surfaces actual error reasons in pickAgent
  (replaces the silent X from the v0.4.0 screenshot).
- Worktree isolation per session via `@founder-os/worktree-manager` (falls
  back to repo root if `git worktree add` fails).

### Changed
- Sessions no longer run `vscode.window.createTerminal({ cwd })` +
  `terminal.sendText(launchLine, true)`. That flow depended on the user's
  shell to parse escapes and was the root cause of the Claude "Command
  failed" screenshot. The new flow owns the PTY end-to-end.
- Renamed `apps/builder-extension` -> `apps/founder-cowork`. Fresh install
  identity per the locked rewrite-plan decision.

### Deferred to later phases
- **Phase 1b**: React-based Mission Control rewrite of the 9-tab webview.
- **Phase 2**: handoff dispatcher routing to per-bundle-type runners +
  Tauri-side `handoff_watcher`.
- **Phase 3**: per-agent `AccountManager` (Codex managed-account, Claude
  system-default snapshot, Gemini SecretStorage). Until then,
  `founderCowork.anthropicApiKey` setting remains in place for the handoff
  BuildRunner.
- **Phase 4**: InsForge backend.
- **Phase 5**: polish, e2e tests, migration notes.

### Known limitations
- VSIX is currently single-platform (Windows ConPTY binary only). For
  macOS/Linux distribution, ship per-platform VSIXes via
  `vsce package --target win32-x64` etc, or copy all of node-pty's
  prebuilds into `out/native/`.
- Ollama (HTTP injection mode) refuses to spawn as a PTY session; it'll
  surface in the Mission Control Ollama tab once Phase 1b lands.

## [0.2.1] - 2026-04-23

- Pre-rewrite checkpoint: handoff inbox watcher + status tree + integrated-
  terminal session spawning. Known broken on Windows due to .ps1 runner.

## [0.1.0] - Unreleased

Initial release as `apps/builder-extension`.

### Added
- Watch-and-execute loop against a venture's `inbox/` folder.
- Activity-bar view showing build status.
- Four commands: pick venture root, run pipeline, accept handoff, show status.
- Settings: venture root, Anthropic key, model, auto-watch.
