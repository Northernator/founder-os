# Dream Vault Rust IPC — Addendum #3 (2026-05-19)

Picks up the template-engine-drift carry-over from addendum #2.
Single coherent change: a monotonic `VAULT_TEMPLATE_VERSION` stamp
on persisted drafts, with the resumed-finalize dispatch now
re-rendering when either the slug OR the template version has moved
since the draft was persisted. Uncommitted on top of the previous
arcs.

Verified: `cargo check` clean, `pnpm --filter founder-desktop
typecheck` clean, vault-runner 12/12 + markdown-vault 33/33 pass.

---

## The problem

Addendum #2 added a re-render branch to the resumed finalize for the
slug-mismatch case. The byte-copy fast path still ran when the slug
matched. That works perfectly as long as the templates haven't
changed between persist and resume — but if the markdown-vault
template content drifts (typo fix, frontmatter tweak, new field
referenced from a template body), persisted drafts carry the OLD
output and the resumed commit lands stale markdown on disk silently.

The carry-over note in addendum #2 sketched two mitigation paths:

> - A "re-render all needs_review drafts" command that runs after a
>   template upgrade.
> - Or a `template_version` column on `vault_note_drafts` and force
>   re-render when the persisted version doesn't match the runtime
>   version.

This addendum ships the second one. It's strictly better than the
one-shot command because:

- It's automatic — bump the constant and the next resume of any
  stale draft re-renders without a maintenance step.
- Drafts that were never resumed (committed in-session before the
  template change) need no intervention.
- The cost is one extra integer per draft row + one integer compare
  per draft at resume time.

---

## What landed

### Constant: `VAULT_TEMPLATE_VERSION`

New export in [`@founder-os/markdown-vault`](packages/markdown-vault/src/templates.ts).
Lives next to the templates themselves so a template-content change
+ a version bump go together in the same commit. Starts at `1`.

The rule-of-thumb comment block in the file spells out when to bump:

```
- Add a template     -> no bump (existing rows still render the same way)
- Change frontmatter -> bump (changes every consumer of every template)
- Change a body str  -> bump (changes rendered output for that template)
- Fix a typo only    -> bump (output is byte-different)
- Rename a variable  -> bump (old drafts will have an empty placeholder)
```

Exported from the package's index so both the renderer (persist
path) and boot-hydration (resume path) can import it.

### Migration 0014

[`apps/founder-desktop/src-tauri/migrations/0014-vault-drafts-template-version.sql`](apps/founder-desktop/src-tauri/migrations/0014-vault-drafts-template-version.sql)
— single `ALTER TABLE` adding `template_version INTEGER NOT NULL
DEFAULT 1` to `vault_note_drafts`. Drafts persisted before 0014
default to `1`, which represents the first stable revision of the
templates — those rows get force-re-rendered on resume if a future
bump moves `VAULT_TEMPLATE_VERSION` past `1`.

Registered as `version: 14` in
[`lib.rs::migrations()`](apps/founder-desktop/src-tauri/src/lib.rs).
**No update needed to `db_smoke.rs`** — we added a column, not a
table; the schema-drift smoke test catches missing tables only.

### Rust wire changes

[`vault.rs`](apps/founder-desktop/src-tauri/src/vault.rs):

- `NoteDraft` struct gained `template_version: u32` with a
  `#[serde(default = "default_template_version")]` so JSON payloads
  missing the field (renderer running against an older version of
  this package) still deserialise cleanly.
- `row_to_draft` reads the new column as `i64` then clamps negatives
  back to `1` before casting to `u32`. Defensive but correct: SQLite
  has no unsigned integer column type.
- `vault_insert_note_draft` SQL now `INSERT OR REPLACE`s 14 columns
  instead of 13. The `template_version as i64` cast handles the
  width difference on the way back into SQLite.
- `vault_list_note_drafts_for_job` SELECT now includes
  `template_version` so `row_to_draft` can populate the new field.

### TS persist

[`run-vault-import.ts`](apps/founder-desktop/src/features/vault/run-vault-import.ts)'s
`persistRunForResume` imports `VAULT_TEMPLATE_VERSION` from
`@founder-os/markdown-vault` and threads it into the
`vault_insert_note_draft` invoke payload as `templateVersion`. One
new field on the row, one new import on the file.

### TS resume

[`boot-hydration.ts`](apps/founder-desktop/src/features/vault/boot-hydration.ts)
gets two changes:

1. `PersistedDraft` wire type gains `templateVersion: number`.
2. `hydrateResumableVaultJobs` builds a parallel
   `templateVersionByNoteId: Map<string, number>` alongside the
   reconstructed drafts. This map threads into `resumedFinalize` as
   a new opt parameter. The runtime `VaultNoteDraft` contract in
   `@founder-os/vault-runner` stays untouched — we deliberately
   don't push template versioning into the cross-package draft
   shape because in-session drafts never need to know about it.

The dispatch predicate inside `resumedFinalize` widens from:

```ts
if (slugMatchesSuggestion) { byteCopy() } else { reRender() }
```

to:

```ts
const slugMatchesSuggestion = approval.ventureSlug === (draft.suggestedVentureSlug ?? null);
const persistedTemplateVersion = templateVersionByNoteId.get(draft.noteId) ?? 1;
const templateUpToDate = persistedTemplateVersion === VAULT_TEMPLATE_VERSION;
if (slugMatchesSuggestion && templateUpToDate) { byteCopy() } else { reRender() }
```

A draft is byte-copied only when **both** clauses hold. Any
deviation routes through `writeVaultNote()` which renders against
the runtime templates from `draft.variables`, so the output is
identical to what an in-session finalize would produce for the same
approval — independent of how stale the persisted preview was.

---

## File summary

### New files

- [`apps/founder-desktop/src-tauri/migrations/0014-vault-drafts-template-version.sql`](apps/founder-desktop/src-tauri/migrations/0014-vault-drafts-template-version.sql) — 28 LOC

### Modified files

- [`packages/markdown-vault/src/templates.ts`](packages/markdown-vault/src/templates.ts) — `VAULT_TEMPLATE_VERSION` constant + rule-of-thumb comment.
- [`packages/markdown-vault/src/index.ts`](packages/markdown-vault/src/index.ts) — re-export.
- [`apps/founder-desktop/src-tauri/src/lib.rs`](apps/founder-desktop/src-tauri/src/lib.rs) — migration 14 entry.
- [`apps/founder-desktop/src-tauri/src/vault.rs`](apps/founder-desktop/src-tauri/src/vault.rs) — `NoteDraft.template_version` field + SELECT/INSERT updates + `default_template_version()` helper + clamp on row read.
- [`apps/founder-desktop/src/features/vault/run-vault-import.ts`](apps/founder-desktop/src/features/vault/run-vault-import.ts) — import + persist stamps `templateVersion`.
- [`apps/founder-desktop/src/features/vault/boot-hydration.ts`](apps/founder-desktop/src/features/vault/boot-hydration.ts) — `PersistedDraft.templateVersion` + `templateVersionByNoteId` map + new dispatch clause.

Total: ~80 LOC added, ~10 LOC edited.

---

## Suggested commit split

2 commits:

1. `feat(vault-rust): template_version on vault_note_drafts`
   - `packages/markdown-vault/src/templates.ts` + `index.ts`
   - `apps/founder-desktop/src-tauri/migrations/0014-vault-drafts-template-version.sql`
   - `apps/founder-desktop/src-tauri/src/lib.rs`
   - `apps/founder-desktop/src-tauri/src/vault.rs`
   - `apps/founder-desktop/src/features/vault/run-vault-import.ts`
   - `apps/founder-desktop/src/features/vault/boot-hydration.ts`

2. `docs(vault-rust): addendum #3 SHIP-NOTES`
   - `bizBuild/DREAM-VAULT-RUST-IPC-SHIP-NOTES-ADDENDUM-3.md`

---

## Smoke-test additions

Layered on top of all prior checklists:

1. **Same-slug, same-version → byte-copy.** Trigger an import,
   reload, commit at the suggested slug. The committed markdown
   should be byte-identical to `vault_note_drafts.preview_content`
   for the matching noteId. No re-render warnings in the toast.

2. **Same-slug, version bump → re-render.** Trigger an import,
   `pnpm --filter @founder-os/markdown-vault` open and bump
   `VAULT_TEMPLATE_VERSION` from `1` to `2`. Reload. Commit at the
   suggested slug. The committed markdown should now match the
   template engine's output for `variables` — NOT the persisted
   `preview_content` (which still reflects version `1`). The
   `vault_note_drafts` row keeps `template_version = 1` until
   cleanup runs.

3. **Verify SQLite column populated correctly.** After any
   in-session import that hits `needs_review`, query:
   ```sql
   SELECT id, template_version FROM vault_note_drafts WHERE import_job_id = '<jobId>';
   ```
   Every row should have `template_version` matching the runtime
   constant (`1` today). Migration-applied rows from before 0014
   default to `1`.

4. **Old draft + version bump combined with slug change.** Bump
   the constant AND route to a different venture. The re-render
   branch fires regardless of which clause triggered it; the
   output should match a fresh in-session finalize.

---

## Carry-overs

Trimmed down to one item now:

- **Drive OAuth + listing + transfers.** Still deferred per the
  original user directive ("no oauth do later").

The template-engine-drift carry-over from addendum #2 is now
fully addressed — no more silent stale-markdown commits.

---

## Verification at ship time

- `cargo check` → 0 errors (same 2 pre-existing warnings in `cli_agent.rs` + `handoff_watcher.rs`).
- `pnpm --filter founder-desktop typecheck` → clean.
- `pnpm --filter @founder-os/markdown-vault typecheck` → clean.
- `pnpm --filter @founder-os/vault-runner test` → 12/12 pass.
- `pnpm --filter @founder-os/markdown-vault test` → 33/33 pass.
