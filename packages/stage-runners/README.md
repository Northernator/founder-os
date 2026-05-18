# @founder-os/stage-runners

Modular per-stage execution runtime for the Founder OS pipeline.

Wraps the existing step modules in `@founder-os/pipeline-runner` with a
uniform `StageRunner` contract:

- `validate()` — preflight checks (API keys, prereq stages complete)
- `run()` — idempotent + resumable; writes artifacts to canonical paths and emits structured logs
- `cleanup?()` — optional temp-file removal

Inspired by MoneyPrinter V2's per-channel agent pattern (`YouTube.py`,
`Twitter.py`) but adapted for a pipeline that pauses at human review
gates instead of running fully automated.

## Status

**Slices 1-13 shipped:** stage-runner contracts, orchestrator, review gates,
failed-run resume/retry, real per-stage runners through BACKEND, and the
Handoff Pack runner are wired into desktop.

- `StageRunner` interface + shared domain schemas remain the contract surface.
- `PipelineOrchestrator` persists stage progress, review gates, logs, and
  failed-run recovery data under `.founder/`.
- Real runners now cover RESEARCH, BRAND, PRODUCT, UK_SETUP, AUDIT, HANDOFF,
  BUILD, VALIDATION, WIREFRAME, FINANCE, LAUNCH, MEDIA, MEDIA_EDIT, CRM,
  BACKEND, and HANDOFF_PACK.
- Handoff Pack renders through the node-only provider path, writes inventory +
  checkpoint artifacts, supports role packs, and is exposed to desktop through
  a Tauri sidecar command rather than direct renderer imports.

## Slice 14 notes

- `@founder-os/stage-runners/node` is the node-only export for
  `HandoffPackStageRunner`; browser-facing code should avoid importing it.
- `stage-runners` CLI emits the JSON envelope consumed by the desktop sidecar
  and reads Handoff Pack counts from the checkpoint.
- CLI and brand-asset JSON reads tolerate UTF-8 BOMs from Windows tooling.
- `@founder-os/handoff-desktop` now has a browser conditional export that
  excludes node filesystem outbox helpers from browser bundles.

## Commit plan

1. Slice 1-13 baseline: contracts, orchestrator, all shipped runner promotions,
   desktop stage wiring, and Handoff Pack renderer/provider work already in the
   current worktree.
2. Slice 13 finish: desktop Handoff Pack sidecar path, white-screen-safe
   renderer boundary, and Tauri command plumbing.
3. Slice 14 hardening: CLI smoke coverage, node-only export, browser-safe
   handoff-desktop entry, BOM-tolerant JSON reads, and real sidecar smoke
   verification against `.tmp/handoff-pack-real-venture`.
4. Follow-up commit: remaining legacy Vite browser-external warnings from
   `pipeline-runner` stage paths, if those older buttons still need renderer
   sidecar migration.

## Naming note

The class **`ResearchStageRunner`** lives here. The package
**`@founder-os/research-runner`** is the unrelated HTTP client to the
Python research sidecar — the suffix on the class disambiguates.
