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

**Slice 1 (current):** contracts only.

- `StageRunner` interface
- Re-exported zod schemas from `@founder-os/domain` (`StageName`,
  `StageRunResult`, `ReviewGate`, `StageProgress`, `ArtifactIndexEntry`,
  `PipelineConfig`)
- Path helpers added in `@founder-os/workspace-core`
  (`getStageProgressPath`, `getReviewGatesPath`, `getStageRunLogPath`,
  `getFailedStageResultPath`)

No runtime behaviour change yet. No callers.

## Upcoming slices

- **Slice 2** — `ResearchStageRunner` wrapping `createSaasResearchReports`
- **Slice 3** — `PipelineOrchestrator` class + `BrandStageRunner` with flag-driven review gate
- **Slice 4** — desktop review-gate panel + `advance-gate.ts` integration
- **Slice 5** — resume/retry via `.founder/handoffs/failed/`
- **Slice 6+** — remaining runners (Product, UK setup, Audit, Build, Launch)

## Naming note

The class **`ResearchStageRunner`** lives here. The package
**`@founder-os/research-runner`** is the unrelated HTTP client to the
Python research sidecar — the suffix on the class disambiguates.
