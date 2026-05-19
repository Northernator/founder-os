# Dream Vault Rust IPC — Addendum (2026-05-19)

Two follow-on arcs filed as carry-overs in
[DREAM-VAULT-RUST-IPC-SHIP-NOTES.md](DREAM-VAULT-RUST-IPC-SHIP-NOTES.md)
landed together. Uncommitted on top of the main Rust IPC arc. Both
verified: `cargo check` clean, full TS typecheck clean, vault-runner
tests 12/12 pass.

---

## Arc A — Migration-drift smoke test

Cheap insurance against the class of bug the main arc opened with:
the DREAM_VAULT slice-1 migration filed at
`packages/db/src/migrations/0002-vault.sql` (npm-package directory)
instead of `apps/founder-desktop/src-tauri/migrations/`, leaving the
Tauri app with no vault tables. Nobody noticed because every renderer
code path was wrapped in `safeInvoke` that swallowed the resulting
errors. This arc catches it on boot.

### What landed

- **New Rust module** [`apps/founder-desktop/src-tauri/src/db_smoke.rs`](apps/founder-desktop/src-tauri/src/db_smoke.rs) (~165 LOC).
  Holds a `REQUIRED_TABLES` manifest of every table the app expects
  to exist (21 tables across migrations 0001 → 0013) and a probe
  function that walks `sqlite_master`. On failure: loud multi-line
  stderr banner that explicitly names the npm-vs-Tauri migrations
  directory mismatch as the most common cause, plus an emitted
  `db:schema-smoke` Tauri event.
- **Setup hook** in [`lib.rs`](apps/founder-desktop/src-tauri/src/lib.rs)'s
  Tauri builder — `.setup(|app| { db_smoke::run_on_boot(&app.handle()); Ok(()) })`
  runs after `tauri-plugin-sql` finishes applying migrations.
- **Tauri command** `db_run_schema_smoke` exposed for renderer-side
  re-probes (e.g., a future "Verify schema" diagnostic button).
- **Renderer subscription** in [`App.tsx`](apps/founder-desktop/src/app/App.tsx) —
  a `useEffect` listens for `db:schema-smoke` events and toasts an
  error when `ok: false`. Includes the missing-table list (truncated
  to 5 in the toast) so the user sees exactly which tables are
  drifted.

### How to add a new table later

1. Land the migration in `apps/founder-desktop/src-tauri/migrations/`
   (not the npm package's mirror).
2. Register the file in `lib.rs::migrations()`.
3. Add the table name to `REQUIRED_TABLES` in `db_smoke.rs`.

Forgetting step 1 was the original bug. Step 3 is the smoke-test
catch — without the migration, the table is missing and the smoke
test fails loudly. Forgetting step 3 means the smoke test won't
warn about *that* table being missing, but the harness wouldn't
have caught the original misplacement either way — step 3 is
defence-in-depth for newly added tables.

### Cost / value

Boot-time probe runs ~21 `SELECT 1 FROM sqlite_master` queries —
sub-millisecond on any modern disk. The Tauri event payload is a
small struct. Single useEffect on the renderer side. Total overhead
< 50 ms; in exchange we get visible, actionable failure when a
migration goes missing again.

---

## Arc B — Resumable vault imports

The Rust IPC arc's slice-4 carry-over: "Persisting drafts / items /
matches so reviews can truly resume across reloads is a separate
arc." This arc ships it.

Before: A reload between vault phase 9 and commit lost every draft
(the runner held them in memory only). Recovered entries from
`hydrateRecoveredVaultJobs` could only be discarded.

After: Drafts / project matches / extracted items persist to SQLite
at the end of every successful run. Boot hydration rebuilds full
`PendingVaultImport` entries with a Tauri-backed `finalize()`. The
founder can close the app mid-review and pick up where they left off
on the next launch.

### Slice B1 — Migration 0013 + 6 Rust commands

- **New migration**
  [`apps/founder-desktop/src-tauri/migrations/0013-vault-drafts.sql`](apps/founder-desktop/src-tauri/migrations/0013-vault-drafts.sql) —
  adds `vault_note_drafts` table with the columns needed to
  reconstruct a `VaultNoteDraft`: noteType, suggestedVentureSlug,
  title, previewContent, previewFrontmatterJson, itemIdsJson,
  tagsJson, confidence, variablesJson. The frontmatter / itemIds /
  tags / variables ride through as JSON so the renderer
  deserialises them after read.
- **`REQUIRED_TABLES` updated** in `db_smoke.rs` so the schema
  smoke test catches a missing 0013 just like 0012.
- **6 new Tauri commands** in
  [`vault.rs`](apps/founder-desktop/src-tauri/src/vault.rs) (~290 LOC added):

| Command | Purpose |
| --- | --- |
| `vault_insert_project_match(row)` | `INSERT OR REPLACE` into `vault_project_matches`. Idempotent re-writes for re-runs. |
| `vault_list_project_matches_for_job(jobId)` | JOIN through `vault_source_documents` so the caller scopes by jobId, not sourceDocumentId. |
| `vault_insert_extracted_item(row)` | Same shape for `vault_extracted_items`. |
| `vault_list_extracted_items_for_job(jobId)` | Same JOIN pattern. |
| `vault_insert_note_draft(row)` | Writes the new `vault_note_drafts` row with all JSON-encoded children. |
| `vault_list_note_drafts_for_job(jobId)` | Direct scan, ORDER BY created_at ASC. |

- **`vault_discard_job` cascade-updated** — slice 4 only deleted
  sources + the job row, which would have left orphan rows in the
  new tables on discard. Now drops, in FK-safe order:
  `vault_note_drafts` → `vault_project_matches` →
  `vault_extracted_items` → `vault_source_extractions` →
  `vault_source_images` → `vault_import_sources` →
  `vault_source_documents` → `vault_import_jobs`. Single
  transaction so any FK violation rolls back cleanly.

### Slice B2 — TS persistence at end of run

[`run-vault-import.ts`](apps/founder-desktop/src/features/vault/run-vault-import.ts)
gets a new `persistRunForResume(run, now)` function called after
`runner.run()` lands a `needs_review` status, ONLY when the SQLite
store probe (slice 1 of the main arc) succeeded. It iterates over
`run.matches` / `run.items` / `run.drafts` and writes each via the
slice-B1 commands.

**Non-fatal** — wrapped in try/catch. The in-session pending review
remains the source of truth during the live session; persistence is
purely a recoverability feature. A failure here logs a warning and
leaves the in-memory state untouched; the user can still review +
commit, they just won't survive a reload.

### Slice B3 — TS resumption + Tauri-backed finalize

[`boot-hydration.ts`](apps/founder-desktop/src/features/vault/boot-hydration.ts)
gets `hydrateResumableVaultJobs({ workspaceRoot })` returning
**both** maps:

```ts
{
  resumable: Map<string, PendingVaultImport>;   // full review state
  legacyRecovered: Map<string, RecoveredVaultImport>;  // discard-only
}
```

For each `needs_review` job in SQLite, the function parallel-pulls
sources + matches + items + drafts via `Promise.all`. If drafts come
back non-empty, the job is **resumable**: rebuild a `VaultRunResult`
+ `RunVaultImportResult` from the persisted rows; supply a
Tauri-backed `resumedFinalize()` that:

1. Resolves the target path via
   [`@founder-os/markdown-vault`](packages/markdown-vault/src/paths.ts)'s `resolveVaultNotePath`
   for each approved draft.
2. Calls `mkdir_p` + `write_file` (existing desktop Tauri commands)
   to drop the persisted `previewContent` markdown on disk.
3. Flips the job row to `committed` via `vault_update_job_status`.

The persisted `previewContent` is the rendered markdown — no
template re-rendering needed. Trade-off: if the reviewer routes to a
different venture slug than the original suggestion, the frontmatter
inside the note body still reflects the old slug. Re-rendering with
the new slug at finalize time is a follow-up; today's behaviour
matches the spec's commit semantics (the renderer doesn't track
which slug each draft was suggested for vs picked).

Jobs with zero persisted drafts (pre-arc imports + any run where
slice-B2 persistence failed mid-flight) fall through to the
`legacyRecovered` map and surface as discard-only entries via the
existing slice-4 `RecoveredVaultImportRow` UX.

**Type-system change**: `RunVaultImportResult.runner` was made
optional. In-session entries set it; resumed entries don't (resumed
imports have no live LLM caller / extractor ports / fs port — those
are session-bound). The review screen never reads `runner` so the
change is contained.

**App boot integration**:
[`App.tsx`](apps/founder-desktop/src/app/App.tsx) calls
`hydrateResumableVaultJobs({ workspaceRoot })` in a new boot
`useEffect`. Resumable entries merge into `pendingVaultImports`
with **in-session entries winning over resumed entries by jobId**
— if the user imports something fresh, the live runner stays, and a
later workspace-root change re-running hydration doesn't stomp it.
Legacy recovered entries flow into the existing
`recoveredVaultImports` state. Same `VaultPendingImportsPanel`
renders both kinds with their distinct action sets.

---

## Architectural notes worth flagging

### 1. `INSERT OR REPLACE` for idempotent re-runs

Every persisted match / item / draft uses `INSERT OR REPLACE` on its
primary key. If the user re-imports the same job (same id collision —
shouldn't happen in practice since `jobId = vimp-<ts>-<rand>` but the
guarantee is cheap), the new row stomps the old. Safer than
`INSERT` which would error on collision and leave the persistence
half-applied.

### 2. Resumed entries never see a `runner`, but the type stays

Making `runner` optional in `RunVaultImportResult` rather than
introducing a new `ResumedVaultImportResult` type was the lighter
change. The review screen, the pending-imports panel, the browser
all consume `pending.result.run.*` + `pending.result.finalize` and
never touch `runner`. Anyone in the future who *does* need to
distinguish can check `result.runner === undefined`.

### 3. Old drafts pile up under committed jobs

Today's resumed finalize flips the job to `committed` but doesn't
delete the matches / items / drafts rows. Boot hydration filters by
`status = "needs_review"` so they don't re-surface as pending, but
they live in SQLite as historical data. The in-session finalize (via
`runner.finalize()` → `commitImportJob`) has the same behaviour —
slice 1 of the main arc didn't ship a cleanup pass either.

Long-term: a `vault_cleanup_committed_job(jobId)` command that nukes
the support rows once the markdown is safely on disk. Out of scope
for this arc; flagged for a future housekeeping pass.

### 4. The smoke test catches its own arc

Migration 0013 lives in the right directory because the manifest in
`db_smoke.rs::REQUIRED_TABLES` lists `vault_note_drafts`. If a
future arc accidentally files a migration in the npm-package
directory again, the smoke test trips the same way it would for
the original DREAM_VAULT bug — exactly the failure mode we set out
to prevent.

---

## File summary

### New files

- [`apps/founder-desktop/src-tauri/migrations/0013-vault-drafts.sql`](apps/founder-desktop/src-tauri/migrations/0013-vault-drafts.sql) — 46 LOC
- [`apps/founder-desktop/src-tauri/src/db_smoke.rs`](apps/founder-desktop/src-tauri/src/db_smoke.rs) — 165 LOC

### Modified Rust files

- [`apps/founder-desktop/src-tauri/src/lib.rs`](apps/founder-desktop/src-tauri/src/lib.rs)
  — `mod db_smoke` + 7 invoke_handler entries + `.setup()` hook + migration 13 registration
- [`apps/founder-desktop/src-tauri/src/vault.rs`](apps/founder-desktop/src-tauri/src/vault.rs)
  — 6 new commands, cascade-updated `vault_discard_job`

### Modified TS files

- [`apps/founder-desktop/src/features/vault/run-vault-import.ts`](apps/founder-desktop/src/features/vault/run-vault-import.ts)
  — `persistRunForResume` + made `runner` optional on `RunVaultImportResult`
- [`apps/founder-desktop/src/features/vault/boot-hydration.ts`](apps/founder-desktop/src/features/vault/boot-hydration.ts)
  — `hydrateResumableVaultJobs` + `resumedFinalize` + draft rehydration helpers
- [`apps/founder-desktop/src/app/App.tsx`](apps/founder-desktop/src/app/App.tsx)
  — swapped `hydrateRecoveredVaultJobs` for `hydrateResumableVaultJobs` + schema-smoke event listener

Rough total: ~700 LOC of new code, ~50 LOC of TS edits.

---

## Suggested commit split

3 commits, one per arc/slice:

1. `feat(vault-rust): migration-drift smoke test (db_smoke.rs + boot probe)`
   - `apps/founder-desktop/src-tauri/src/db_smoke.rs` (new)
   - `apps/founder-desktop/src-tauri/src/lib.rs` (mod + setup hook + invoke_handler)
   - `apps/founder-desktop/src/app/App.tsx` (event listener useEffect)

2. `feat(vault-rust): resumable vault imports — migration 0013 + 6 Rust commands`
   - `apps/founder-desktop/src-tauri/migrations/0013-vault-drafts.sql` (new)
   - `apps/founder-desktop/src-tauri/src/lib.rs` (migration entry + 6 invoke_handler entries)
   - `apps/founder-desktop/src-tauri/src/vault.rs` (6 new commands + cascade fix)
   - `apps/founder-desktop/src-tauri/src/db_smoke.rs` (vault_note_drafts in manifest)

3. `feat(vault-rust): resumable vault imports — TS persistence + boot resumption`
   - `apps/founder-desktop/src/features/vault/run-vault-import.ts` (`persistRunForResume` + optional `runner`)
   - `apps/founder-desktop/src/features/vault/boot-hydration.ts` (resumable hydration + Tauri finalize)
   - `apps/founder-desktop/src/app/App.tsx` (swap hydration source, dependency on workspaceRoot)

4. `docs(vault-rust): addendum SHIP-NOTES`
   - `bizBuild/DREAM-VAULT-RUST-IPC-SHIP-NOTES-ADDENDUM.md`

---

## Smoke-test checklist

Layered on top of the main arc's checklist:

1. **Fresh boot.** Confirm `[db_smoke] schema OK: 22/22 tables present`
   in stderr. No toast on the renderer side (success is silent).
2. **Force a drift.** Comment out the migration-12 entry in
   `lib.rs::migrations()`, rebuild, launch with a fresh DB. Expect:
   loud multi-line stderr banner naming the 9 missing
   `vault_*` tables, plus a toast on the renderer side. Reapply
   the entry to restore.
3. **Resumable round-trip.** Start a local-file import, wait for
   `needs_review`, **do not commit**. Reload the app. The pending
   panel should show the same import with a *full* review button
   (not the dashed "recovered" badge). Click Review → confirm the
   draft list, project matches, and extracted items are all
   populated. Approve some, reject some, click Commit. Expect:
   approved notes land under
   `<workspaceRoot>/_vault/projects/<slug>/.../<noteId>.md` or
   `<workspaceRoot>/_vault/unsorted/<bucket>/<noteId>.md`. Job row
   in SQLite flips to `committed`.
4. **Legacy recovered.** Manually `DELETE FROM vault_note_drafts WHERE
   import_job_id = '<some_job_id>'` then reload. That job should now
   surface as discard-only (legacy recovered) since drafts are gone
   but the job row is still `needs_review`. Click Discard →
   `vault_discard_job` runs the new cascade through all 8 tables.
5. **In-session wins over resumed.** Start an in-session import to
   `needs_review`. Switch active venture (changes `workspaceRoot`)
   → hydration re-runs. Confirm the in-session entry still has the
   live runner (Review button works against the original drafts in
   memory, not the SQLite-rebuilt copy).
6. **Cascade discard.** Discard a fully-resumable entry. Verify all
   8 tables drop rows for that jobId via DB browser.

---

## Carry-overs

- **Re-rendering at resumed-finalize time.** When the reviewer picks
  a different venture slug than the original suggestion, the
  rendered markdown still carries the old slug in its frontmatter.
  Cheap fix: at finalize, if `approval.ventureSlug !=
  draft.suggestedVentureSlug`, re-render via the markdown-vault
  template engine instead of byte-copying `previewContent`.
- **Cleanup pass for committed jobs.** Drafts / matches / items rows
  stick around under `status = 'committed'` job ids. Doesn't break
  anything but bloats `founder.db` over time. Future
  `vault_cleanup_committed_job(jobId)` command.
- **Drive OAuth + listing + transfers.** Still deferred. Same plan
  as the main arc's carry-over.

---

## Verification at ship time

- `cargo check` → 0 errors (2 pre-existing warnings in `cli_agent.rs` + `handoff_watcher.rs` unrelated to this arc).
- `pnpm --filter founder-desktop typecheck` → clean.
- `pnpm --filter @founder-os/vault-runner test` → **12/12 pass**.
- `pnpm --filter @founder-os/markdown-vault typecheck` → clean.
- `pnpm --filter @founder-os/document-extractor typecheck` → clean.
