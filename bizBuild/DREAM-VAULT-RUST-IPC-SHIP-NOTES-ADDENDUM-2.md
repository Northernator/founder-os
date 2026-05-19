# Dream Vault Rust IPC — Addendum #2 (2026-05-19)

Two carry-over polish arcs from the first addendum landed together.
Both uncommitted on top of the resumable-imports work. Verified:
`cargo check` clean, full TS typecheck clean, vault-runner 12/12 +
markdown-vault 33/33 tests pass.

---

## Arc A — Re-render at resumed-finalize when slug differs

Before: the resumed finalize byte-copied the persisted
`previewContent` regardless of which slug the reviewer picked. If
the reviewer routed a draft to a different venture than the
project-classifier's suggestion, the markdown body landed at the
right *path* but its frontmatter still carried the OLD `projectSlug`
field — inconsistent with what the in-session finalize would have
produced for the same approval.

After: the resumed finalize dispatches on slug-equality. Matching
slug → byte-copy fast path. Differing slug → re-render through
`@founder-os/markdown-vault`'s `writeVaultNote()` so the frontmatter
+ body get rebuilt against the new slug, matching the in-session
behaviour byte-for-byte (modulo the new `createdAt` reflecting commit
time rather than the original run's `now`, which is the same trade
the in-session path has always made).

### What landed

- **New helper module** [`apps/founder-desktop/src/features/vault/tauri-fs-port.ts`](apps/founder-desktop/src/features/vault/tauri-fs-port.ts) —
  `createTauriFsPort()` builds a `VaultFsPort` from the existing
  desktop commands (`mkdir_p` / `write_file` / `path_exists`). Three
  methods, ~20 LOC of glue. No new Rust surface — every command the
  port needs already shipped before the Rust IPC arc.
- **`resumedFinalize` dispatch** in [`boot-hydration.ts`](apps/founder-desktop/src/features/vault/boot-hydration.ts):
  ```
  if (approval.ventureSlug === draft.suggestedVentureSlug ?? null) {
    // byte-copy previewContent (fast path)
  } else {
    // writeVaultNote(input, fsPort) — re-render with new slug
  }
  ```
  The re-render path threads `draft.title` / `sourceDocumentId` /
  `itemIds` / `tags` / `confidence` / `variables` straight from the
  persisted row, plus the new `ventureSlug` from the approval and
  `now` from the finalize input. `writeVaultNote` does the template
  render + frontmatter encode + sanitise + write. Its warnings +
  unresolved-placeholders are forwarded into the
  `VaultFinalizeResult.warnings` array prefixed with the draft id
  so the reviewer can see which note generated which warning.

### Trade-offs

- The fast-path branch is still a byte-copy — if you reload a job
  whose drafts were persisted by a *different* version of the
  template engine (older arc), the byte-copy preserves the older
  output even if the new template would produce different markdown.
  Acceptable: the persisted preview is the markdown the reviewer
  saw at review time, so committing it byte-for-byte is the
  intuitive behaviour. Template-engine upgrades that *must* re-render
  every old draft would need a separate "re-render all needs_review
  drafts" pass.
- The re-render path runs the full template engine + sanitiser per
  approved draft. Negligible cost (sub-ms each) but worth
  acknowledging for very-large-multi-draft sessions.

---

## Arc B — Cleanup pass for committed-job support rows

Before: drafts / project matches / extracted items persisted to
SQLite (slice B1 of the resumable arc) stayed forever under
`status = 'committed'` jobs. Boot hydration filtered them out so they
didn't re-surface as pending, but they accumulated in `founder.db`
indefinitely — a slow leak that didn't break anything but bloated the
disk file over months.

After: both finalize paths drop the three transient tables after a
successful commit. Status-guarded server-side so a mistaken caller
can't wipe a needs_review job's state.

### What landed

- **New Rust command** in [`vault.rs`](apps/founder-desktop/src-tauri/src/vault.rs):
  ```rust
  vault_cleanup_committed_job_support(jobId)
    -> { jobId, draftsDropped, matchesDropped, itemsDropped }
  ```
  - Reads `vault_import_jobs.status` first. If the row is missing,
    no-op success. If the row is in any status other than
    `committed`, **returns an error** — refusing to drop state for
    a job that's still in review.
  - Single transaction, deletes from `vault_note_drafts` →
    `vault_project_matches` → `vault_extracted_items`. Reports
    per-table row counts so callers can toast the cleanup result
    if they want (the renderer-side wiring doesn't toast today;
    success is silent).
  - What it does NOT touch: `vault_import_jobs` (status stays
    `committed`), `vault_source_documents` (historical record),
    `vault_notes` (the committed-note index that the browser
    surfaces), `vault_source_extractions` / `vault_source_images` /
    `vault_import_sources` (per-source diagnostics).
- **In-session finalize wired** in [`run-vault-import.ts`](apps/founder-desktop/src/features/vault/run-vault-import.ts).
  The returned `finalize` callback was previously
  `(input) => runner.finalize(input)`; now it awaits the runner's
  result, and if `status === "committed"` AND the SQLite store
  was active, fires `vault_cleanup_committed_job_support`.
  Failures append to the result's `warnings` array; they don't
  roll back the commit because the markdown is already on disk.
- **Resumed finalize wired** in [`boot-hydration.ts`](apps/founder-desktop/src/features/vault/boot-hydration.ts).
  Same pattern after the `vault_update_job_status → committed`
  call. If the status flip failed, the cleanup is still attempted
  but will (correctly) fail the status guard and surface as a
  warning — the support rows stay around for a retry, exactly the
  recovery behaviour we want.

### Why the status guard matters

Without it, a caller that confuses pending and committed jobIds
could wipe the resumable state of a needs_review review. The guard
makes the command essentially impossible to misuse: it's a one-way
ratchet that only fires when the job has already transitioned to
`committed`. Even racing a discard against a cleanup is safe — if
the job has been deleted by the time cleanup runs, the missing-row
branch silently succeeds (nothing to clean up).

---

## File summary

### Modified Rust files

- [`apps/founder-desktop/src-tauri/src/vault.rs`](apps/founder-desktop/src-tauri/src/vault.rs)
  — added `CleanupCommittedSupportResult` + `vault_cleanup_committed_job_support` command.
- [`apps/founder-desktop/src-tauri/src/lib.rs`](apps/founder-desktop/src-tauri/src/lib.rs)
  — registered the new command in `invoke_handler!`.

### New TS files

- [`apps/founder-desktop/src/features/vault/tauri-fs-port.ts`](apps/founder-desktop/src/features/vault/tauri-fs-port.ts) — Tauri-backed `VaultFsPort`.

### Modified TS files

- [`apps/founder-desktop/src/features/vault/boot-hydration.ts`](apps/founder-desktop/src/features/vault/boot-hydration.ts)
  — slug-mismatch dispatch + writeVaultNote import + post-commit cleanup invoke.
- [`apps/founder-desktop/src/features/vault/run-vault-import.ts`](apps/founder-desktop/src/features/vault/run-vault-import.ts)
  — `finalize` callback now awaits the runner + invokes cleanup on success.

Rough total: ~210 LOC new (~140 Rust, ~70 TS) + ~50 LOC of edits.

---

## Suggested commit split

2 commits:

1. `feat(vault-rust): re-render at resumed-finalize when slug differs`
   - `apps/founder-desktop/src/features/vault/tauri-fs-port.ts` (new)
   - `apps/founder-desktop/src/features/vault/boot-hydration.ts`

2. `feat(vault-rust): cleanup pass for committed-job support rows`
   - `apps/founder-desktop/src-tauri/src/vault.rs` (new command)
   - `apps/founder-desktop/src-tauri/src/lib.rs` (invoke_handler)
   - `apps/founder-desktop/src/features/vault/boot-hydration.ts` (resumed wiring)
   - `apps/founder-desktop/src/features/vault/run-vault-import.ts` (in-session wiring)

3. `docs(vault-rust): addendum #2 SHIP-NOTES`
   - `bizBuild/DREAM-VAULT-RUST-IPC-SHIP-NOTES-ADDENDUM-2.md`

---

## Smoke-test additions

Layered on top of the prior checklists:

1. **Re-render path (slug match).** Import a doc, accept the
   classifier's suggested slug at commit. Compare the committed
   markdown's first frontmatter block to the previewContent in the
   `vault_note_drafts` row that *would have been* persisted (you
   can see this in the review screen before commit). Should be
   byte-identical.

2. **Re-render path (slug mismatch).** Import a doc, ROUTE TO A
   DIFFERENT VENTURE at commit. Confirm:
   - The committed markdown's `projectSlug` frontmatter field
     reflects the new slug, not the suggestion.
   - The file landed under the new venture's tree, not the
     suggested one.
   - The review screen warnings (if any) include the re-render
     warnings prefixed with the draft id.

3. **Cleanup after in-session commit.** Import a doc, commit
   normally. Check SQLite:
   ```
   SELECT COUNT(*) FROM vault_note_drafts WHERE import_job_id = '<jobId>';
   SELECT COUNT(*) FROM vault_project_matches WHERE source_document_id IN
     (SELECT id FROM vault_source_documents WHERE import_job_id = '<jobId>');
   SELECT COUNT(*) FROM vault_extracted_items WHERE source_document_id IN
     (SELECT id FROM vault_source_documents WHERE import_job_id = '<jobId>');
   ```
   All three should be 0 after commit. `vault_import_jobs` row
   still present with `status = 'committed'`;
   `vault_source_documents` rows still present.

4. **Cleanup after resumed commit.** Import a doc, reload mid-
   review, commit from the resumed pending entry. Same SQLite
   verification as #3.

5. **Cleanup status guard.** Manually invoke
   `vault_cleanup_committed_job_support` with a jobId whose
   `status = 'needs_review'`. Should return an error explaining
   the status mismatch. Drafts/matches/items rows should remain
   intact.

---

## Carry-overs

The remaining items from the prior addendum's carry-over list:

- **Drive OAuth + listing + transfers.** Still deferred per user
  directive.

New from this arc:

- **Template-engine drift across reloads.** The fast-path byte-copy
  preserves the markdown a *previous* version of the template
  engine produced. Acceptable today but if a future arc changes
  the template content, drafts persisted before that change will
  commit with the old output. Mitigation: a "re-render all
  needs_review drafts" command that runs after a template
  upgrade, or just bump a `template_version` column on
  `vault_note_drafts` and force re-render when the persisted
  version doesn't match the runtime version. Out of scope for
  this arc; flag for whenever template-content changes ship.

---

## Verification at ship time

- `cargo check` → 0 errors (2 pre-existing warnings in `cli_agent.rs` + `handoff_watcher.rs` unrelated).
- `pnpm --filter founder-desktop typecheck` → clean.
- `pnpm --filter @founder-os/vault-runner test` → 12/12 pass.
- `pnpm --filter @founder-os/markdown-vault test` → 33/33 pass.
