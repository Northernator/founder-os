# Founder OS

Local-first Founder OS + Builder OS monorepo. Desktop app (Tauri) is the command center; VS Code extension is the build/execution arm. They meet through a file-backed handoff contract on disk.

## Quick start

```bash
# requires: node >= 20, pnpm >= 10, rust toolchain (for Tauri)
pnpm install
pnpm typecheck          # sanity check the graph compiles
pnpm desktop:dev        # run desktop frontend in browser
pnpm desktop:tauri      # run full Tauri desktop app
pnpm extension:build    # build VS Code extension
pnpm seed               # create a demo venture and run the pipeline end-to-end
```

## Architecture

- `apps/founder-desktop` — Tauri desktop control center (chat-first UI, owns orchestration + artifact truth)
- `apps/builder-extension` — VS Code extension (owns code execution + audits)
- `packages/*` — 22 shared packages with strict dependency rules

### The one-sentence architecture
> Desktop owns orchestration, local state, and artifact truth; VS Code owns code execution and audit; both meet only through a shared file-backed handoff contract.

### Truth model
- **Filesystem** is truth for artifacts, chats, handoffs, audit reports
- **SQLite** (via Drizzle) is truth for indexes, dashboard state, searchable metadata

## Ventures
Each venture lives at `ventures/<slug>/` with this canonical layout:

```
ventures/<slug>/
├─ venture.yaml
├─ .founder/
│  ├─ state/         <- pipeline + run state (mirrors SQLite)
│  ├─ chats/         <- chat transcripts as JSONL
│  ├─ artifacts/     <- artifact index json
│  ├─ handoffs/      <- inbox / working / outbox / failed
│  └─ logs/
├─ 00_inbox/ ... 09_operate/
```

## Handoff flow (desktop ↔ VS Code)

1. Desktop writes a `HandoffBundle` JSON → `.founder/handoffs/inbox/run-<id>.json`
2. Extension watcher picks it up, validates with Zod, moves to `working/`
3. Extension runs the appropriate runner (build / audit / red-team)
4. Extension writes `run-<id>.result.json` → `.founder/handoffs/outbox/`
5. Desktop ingests, indexes new artifacts, advances the pipeline stage

## Package dependency rules

- Pure contracts (`domain`, `*-contract`) import nothing runtime
- UI packages never import `db` or `workspace-*` directly — use `@founder-os/query`
- `builder-extension` never imports `workspace-tauri` or any UI package
- Everything crossing desktop ↔ extension goes through `@founder-os/handoff-contract`

## Pipeline stages

`IDEA → RESEARCHED → VALIDATED → BRAND_READY → SPEC_READY → WIREFRAME_READY → STITCH_READY → BUILD_READY → AUDIT_READY → LAUNCH_READY → MEDIA_READY → MEDIA_EDIT_READY → CRM_READY → UK_SETUP_READY → LIVE`

## Contributing

After cloning, run `pnpm install` once. This installs the pre-commit hook (via `simple-git-hooks`) that runs Biome on staged files only — fast on small diffs, blocks on lint or format violations. JSON/Markdown/YAML are auto-formatted; TypeScript and JavaScript are checked but never silently rewritten.

If a commit is blocked by Biome, fix the reported issues and re-stage. To bypass the hook in an emergency: `git commit --no-verify` (don't make a habit of it — full-repo lint also runs in CI).
