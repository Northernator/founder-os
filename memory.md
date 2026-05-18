# Session Memory

## 2026-05-18

### Slice 13 Finish + Slice 14 Handoff Pack Desktop Hardening

- Finished the Handoff Pack desktop execution path by keeping the renderer/browser side clean and routing the real work through the Tauri sidecar command.
- Added `@founder-os/stage-runners/node` as the node-only export surface for `HandoffPackStageRunner`.
- Added a testable stage-runners CLI entrypoint and CLI smoke coverage for `handoff-pack-run-stage`.
- CLI sidecar envelope now reports counts/status from `13_handoff_pack/handoff-pack-checkpoint.json` instead of inferring from artifact paths, so desktop sees real `docsRendered`, `failed`, role-pack, and inventory state.
- Hardened JSON parsing for UTF-8 BOMs in both the CLI manifest read and Handoff Pack brand-asset provider read.
- Added browser conditional export for `@founder-os/handoff-desktop` so browser bundles avoid node filesystem outbox helpers.
- Updated `packages/stage-runners/README.md` with shipped slices 1-13 status, Slice 14 notes, and commit plan.
- Verified a real on-disk sidecar smoke against `.tmp/handoff-pack-real-venture`; output reached the runner and returned a useful envelope: brand ok, role pack ok, inventory ok, doc failures from checkpoint.

Touched main files:
- `packages/stage-runners/src/cli.ts`
- `packages/stage-runners/src/node.ts`
- `packages/stage-runners/test/handoff-pack-cli.test.ts`
- `packages/stage-runners/package.json`
- `packages/stage-runners/README.md`
- `packages/handoff-desktop/package.json`
- `packages/handoff-desktop/src/browser.ts`
- `packages/handoff-pack-providers/src/node/prepare-brand-assets.ts`

Verification run:
- `pnpm --filter @founder-os/stage-runners test -- handoff-pack`
- `pnpm --filter @founder-os/stage-runners test -- handoff-pack-cli`
- `pnpm --filter @founder-os/stage-runners typecheck`
- `pnpm --filter @founder-os/handoff-pack-providers test -- prepare-brand-assets`
- `pnpm --filter @founder-os/handoff-pack-providers typecheck`
- `pnpm --filter @founder-os/handoff-desktop typecheck`
- `pnpm --filter founder-desktop build`

Residual note:
- Desktop build still emits legacy Vite browser-external warnings from older `pipeline-runner` imports (`node:fs/promises`, `node:path`, `node:child_process`). These were not caused by Handoff Pack sidecar work and are listed as follow-up.

### Sales Tab Layout Fix

- Fixed Sales page clipping/sideways overflow.
- The tab root now has proper vertical scrolling and hidden horizontal overflow.
- Cards, long file paths, inline code, inputs/buttons, email action rows, and the follow-up chat area now wrap or size within the viewport.

Touched file:
- `apps/founder-desktop/src/features/ventures/SalesTab.tsx`

Verification run:
- `pnpm --filter founder-desktop typecheck`
- `pnpm --filter founder-desktop build`

### Spec Tab Layout Fix

- Removed horizontal scrolling from the Spec tab while preserving vertical scrolling.
- Changed the root scroll surface to `overflowY: auto` and `overflowX: hidden`.
- Added `minWidth: 0` containment through the main columns, cards, sticky sidebars, draft panel, and row layouts.
- Converted fixed-width/rigid rows to wrapping or auto-fit layouts so the page fits narrower desktop windows.
- Header controls now wrap instead of pushing the page wider.

Touched file:
- `apps/founder-desktop/src/features/ventures/SpecTab.tsx`

Verification run:
- `pnpm --filter founder-desktop typecheck`
- `pnpm --filter founder-desktop build`

