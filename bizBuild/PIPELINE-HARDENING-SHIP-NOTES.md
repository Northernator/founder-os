# Pipeline Hardening — Ship Notes (2026-05-18)

Eight fixes from the architectural review of the founder-os monorepo, sequenced quick-wins first. All changes uncommitted on top of `e03790a` (or wherever the prior arc landed). No production data touched.

---

## What landed

### Fix #1 — Domain circular dependency unblocked
**Files**
- `packages/media-core/package.json` — dropped unused `@founder-os/domain` workspace dep
- `packages/crm-core/package.json` — same
- `packages/social-core/package.json` — same
- `packages/media-edit-core/package.json` — already clean, no change

**What changed**
The cycle was `@founder-os/domain ↔ media-core / crm-core / social-core`. Grepping the `*-core` packages showed they **never imported anything from `@founder-os/domain`** — the workspace dep was dead weight in those package.json files. Dropping the back-edges from the leaf packages preserves `domain → *-core` (real imports) and removes the cycle.

**Why this differs from the original plan**
The original analysis suggested "drop domain's deps on `*-core` and inline the config schemas." That would have required moving four zod schemas into domain. The cleaner fix is the opposite: the cycle is one-sided in actual imports, so dropping the unused declarations in the leaf packages is a 3-line change that achieves the same effect.

**Required after merge** — `pnpm install` to regenerate the lockfile.

---

### Fix #2 — Research stage now sends `venture.slug`
**File**
- `apps/founder-desktop/src/features/ventures/ResearchChatPanel.tsx` (lines ~263, ~345, ~413 and 3 dep arrays)

**What changed**
Three call sites (`createDeepResearch`, `scanCompetitors`, `synthesizeIcp`) were passing `venture.id` (UUID-ish) into the `venture_slug` field. `services/research-py/src/research_py/routes/research.py` validates the slug as lowercase alnum with `-`/`_` and writes outputs to `ventures/<slug>/...`. Sending the id instead either (a) failed validation, or (b) wrote artifacts to a UUID-named folder the rest of the pipeline doesn't read from.

`run-research-stage.ts` and its `ResearchStageRunner` were not affected — they use absolute `ventureRoot` paths via the filesystem port, not the research-py HTTP API.

---

### Fix #3 — `BACKEND` is back in `runAllStages`
**Files**
- `apps/founder-desktop/src/lib/run-all-stages.ts` — added `runBackendStage` import, added `"BACKEND"` to `STAGE_ORDER` between HANDOFF and AUDIT, added `case "BACKEND":` to the dispatch switch

**What changed**
`STAGE_ORDER` had every other stage but BACKEND. `runBackendStage.ts` and `BackendStageRunner` were already wired and working in `BackendTab` — they were just unreachable from "Run all stages". BACKEND slots before BUILD because the build step reads `backend-export.json`.

---

### Fix #4 — Deterministic stages no longer require an LLM provider
**Files**
- `apps/founder-desktop/src/lib/run-validation-stage.ts`
- `apps/founder-desktop/src/lib/run-wireframe-stage.ts`
- `apps/founder-desktop/src/lib/run-finance-stage.ts`
- `apps/founder-desktop/src/lib/run-launch-stage.ts`

**What changed**
Each helper used to early-return `{ kind: "no-provider" }` when `buildPipelineLlmCaller()` returned `null`. The underlying runners (`ValidationStageRunner`, `WireframeStageRunner`, `FinanceStageRunner`, `LaunchStageRunner`) all have deterministic fallback paths — they accept an optional `callLlm` and produce templated narratives when it's undefined. The helpers now pass `callLlm` conditionally instead of bailing.

The `{ kind: "no-provider" }` variant is **kept in each return type** for back-compat with the existing callers in `ValidationTab.tsx` / `ScreensTab.tsx` / `AuditTab.tsx` that branch on `out.kind === "no-provider"`. Those branches are now unreachable but harmless. Cleaning them up is a follow-up — the right move is to expose `summarySource: "deterministic"` to the toast copy and drop the no-provider banner.

---

### Fix #5 — Canonical `StageGraph` added
**Files**
- `packages/domain/src/stage-graph.ts` (new file, ~329 lines)
- `packages/domain/src/index.ts` — `export * from "./stage-graph.js"`

**What changed**
One canonical metadata table for every stage. Each `StageGraphNode` captures `id / label / folder / dependencies / producedVentureStage / defaultReviewGate / providerRequired / tabOwner`. Plus helpers:
- `topologicalStageOrder()` — derives a linear order from the dep edges
- `getStageGraphNode(name)` — lookup by `StageName`
- `stagesProducedByVentureStage(marker)` — reverse mapping
- `defaultReviewGateStages()` / `providerRequiredStages()` — convenience filters

`STAGE_NAME_ORDER`, `STAGE_PRODUCES`, `DEFAULT_REVIEW_GATES`, and the desktop's local `STAGE_ORDER` are all **preserved unchanged**. The StageGraph is additive — consumers move at their own pace. The smoke tests assert parity between the graph and the legacy bridges so any future drift between them flags loudly.

**Known parity quirks the graph documents (does not fix)**
- `FINANCE.producedVentureStage = "BRAND_READY"` — finance is parallel-to-brand and doesn't advance the gate. Mirrored from `STAGE_PRODUCES`.
- `HANDOFF.producedVentureStage = "STITCH_READY"` — back-compat marker name from the dual-handoff arc.

---

### Fix #6 — UK_LEGAL_CONSTANTS
**Files**
- `packages/domain/src/uk-setup.ts` — new exported `UK_LEGAL_CONSTANTS`, comment refresh on `vatRegistered`
- `apps/founder-desktop/src/features/ventures/UkSetupTab.tsx` — imports `UK_LEGAL_CONSTANTS`, hint reads `vat.registrationThresholdGBP` instead of hardcoded `£85k`

**What changed**
- VAT registration threshold: **£90,000** (raised 1 April 2024; source: GOV.UK VAT registration thresholds)
- VAT deregistration threshold: **£88,000** (same effective date)
- Corporation tax small-profits upper bound: **£50,000** (2023-04-01)
- Corporation tax main-rate threshold: **£250,000** (2023-04-01)
- `lastVerified: "2026-05-18"` — used to flag stale data later

`packages/prompts/src/system-prompts.ts` was already at £90k. The only stale references were `uk-setup.ts:130` and `UkSetupTab.tsx:520`.

---

### Fix #7 — Artifact taxonomy expanded
**Files**
- `packages/artifacts-core/src/index.ts` — `ArtifactTypeSchema` gained 20 new values for backend / media / crm / handoff-pack / launch / validation / finance / social artifacts
- `packages/artifacts-index/src/scanner.ts` — `inferArtifactType` extended with explicit rules for `10_media`, `11_crm`, `12_backend`, `13_handoff_pack`, plus better validation/finance/launch coverage
- `apps/founder-desktop/src/lib/artifacts-scan.ts` — same rules ported to the Tauri-side scanner (they must stay in sync; both files reference each other)
- `packages/workspace-core/src/paths.ts` — `ventureArtifactDirs` now includes `05_finance`, `09_operate`, `10_media`, `11_crm`, `12_backend`, `13_handoff_pack`

**What changed**
Before this pass, every file the scanner didn't explicitly recognise fell into `"research-summary"` — including all backend / media / CRM / handoff-pack output. The scanner also wasn't even traversing those folders. Both ends are now fixed.

---

### Fix #8 — Smoke tests
**Files**
- `packages/stage-runners/test/stage-graph.test.ts` (new, 17 tests)
- `packages/stage-runners/test/pipeline-hardening.test.ts` (new, 23 tests)
- `packages/stage-runners/package.json` — added `@founder-os/artifacts-core` + `@founder-os/artifacts-index` as workspace deps so vitest resolves the imports

**Coverage**
- `STAGE_GRAPH` parity with `STAGE_NAME_ORDER` / `STAGE_PRODUCES` / `DEFAULT_REVIEW_GATES`
- `topologicalStageOrder()` includes BACKEND (fix #3 regression guard) and respects every node's deps
- `BACKEND` comes before `BUILD`, `HANDOFF` before `BACKEND`
- `providerRequired==true` is exactly `RESEARCH` + `BRAND` (no other stage requires a provider after fix #4)
- `inferArtifactType` correctly maps each new folder convention
- `UK_LEGAL_CONSTANTS` holds the current GOV.UK thresholds

I didn't add tests for the React layer (no-provider branches in tab components, ResearchChatPanel's slug field). Those would need a React test setup the project doesn't have. The runner-level tests already cover the deterministic fallback paths (`*-real.test.ts` in the same suite).

---

## Pre-existing bugs surfaced but NOT fixed in this pass

These showed up when running `tsc --noEmit`. They predate this session — files I didn't touch — and look like leftover Edit-tool truncation from prior arcs.

1. `packages/stage-runners/src/index.ts` — had **NULL-byte padding** from line 81 onward. **Fixed** as a side effect (stripped the NULL pad so the re-exports up to line 80 typecheck). The 15+ missing re-export lines from prior slices are NOT restored — re-add them via `git restore` or a python3 raw-bytes pass if anything broke. The new runners (Backend / Media / Media-Edit / CRM / Handoff-Pack) may need their re-exports re-added.
2. `packages/handoff-pack-providers/src/node.ts` — truncated mid-import-list at byte 5390.
3. `packages/handoff-pack-providers/src/node/prepare-brand-assets.ts` — truncated mid-object at byte 9000.
4. `packages/handoff-pack-providers/src/node/render-handoff-pack-artefacts.ts` — truncated mid-spread at byte 9887.

For (2)–(4) the on-disk content has no NULL padding — it just stops mid-statement. Repair via `git show HEAD:<path>` + python3 raw-bytes write, then re-apply whatever uncommitted slice they came from.

---

## Suggested commit split

All files are uncommitted in the working tree, matching your usual `--no-verify` flow. Suggested split:

```
1.  fix(domain): break circular dependency on *-core packages
    packages/{media-core,crm-core,social-core}/package.json

2.  fix(research): send venture.slug not venture.id to research-py
    apps/founder-desktop/src/features/ventures/ResearchChatPanel.tsx

3.  fix(pipeline): include BACKEND in run-all-stages
    apps/founder-desktop/src/lib/run-all-stages.ts

4.  fix(pipeline): deterministic stages run without LLM provider
    apps/founder-desktop/src/lib/run-{validation,wireframe,finance,launch}-stage.ts

5.  feat(domain): add UK_LEGAL_CONSTANTS for VAT + corporation tax
    packages/domain/src/uk-setup.ts
    apps/founder-desktop/src/features/ventures/UkSetupTab.tsx

6.  feat(artifacts): expand ArtifactType enum + scanner inference
    packages/artifacts-core/src/index.ts
    packages/artifacts-index/src/scanner.ts
    packages/workspace-core/src/paths.ts
    apps/founder-desktop/src/lib/artifacts-scan.ts

7.  feat(domain): canonical StageGraph
    packages/domain/src/stage-graph.ts
    packages/domain/src/index.ts

8.  test(stage-runners): pipeline-hardening smoke tests
    packages/stage-runners/package.json
    packages/stage-runners/test/stage-graph.test.ts
    packages/stage-runners/test/pipeline-hardening.test.ts

9.  fix(stage-runners): strip NULL padding from index.ts (pre-existing)
    packages/stage-runners/src/index.ts
```

---

## Smoke checklist

Before running:
- `pnpm install` (lockfile needs regenerating after the dep changes)
- Repair the three handoff-pack-providers truncations from §"Pre-existing bugs" above

Then:
1. `pnpm --filter @founder-os/domain typecheck` — expect green
2. `pnpm --filter @founder-os/stage-runners test` — expect both new test files green (~40 new test cases) plus the existing 87 cases
3. Open the desktop app on a SaaS venture, hit "Run all stages" with no provider configured — VALIDATION/WIREFRAME/FINANCE/LAUNCH should now produce deterministic output instead of stopping
4. UkSetupTab's VAT hint should read "UK threshold £90k (since 2024-04-01). Below threshold → optional."
5. Run a deep-research on a venture whose `slug` ≠ `id`; confirm reports land under `ventures/<slug>/01_research/...` instead of a UUID directory
6. After BACKEND ships in run-all, confirm BUILD's bundle-out includes the backend-export payload

---

## What I didn't do

- The `FINANCE → BRAND_READY` semantic mismatch. The user flagged this; the StageGraph documents it but doesn't change it. A future slice can introduce `FINANCE_READY`.
- React-tier callers' dead `kind === "no-provider"` branches. Harmless but cluttery. Follow-up.
- Inference rules for the `09_operate/social/posts` folder if/when social moves there — the scanner already picks up `social-posts` paths.
- Repairing the handoff-pack-providers truncations — these need slice-specific knowledge I don't have at this point.
