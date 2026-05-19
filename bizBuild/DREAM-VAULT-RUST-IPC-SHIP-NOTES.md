# Dream Vault Rust IPC — Ship Notes (2026-05-19)

Follow-on arc to DREAM-VAULT-MODULE: turns every TS-side `safeInvoke` /
`DriveCommandNotWiredError` stub from the previous arc into a real Tauri
command. 5 slices, uncommitted on the working tree on top of the vault
arc. Drive OAuth + Drive transfers explicitly deferred (the picker's
"Drive IPC pending" banner stays in place).

---

## What landed

13 new Tauri commands + 1 critical migration fix + 1 Node sidecar CLI +
4 TS-side glue files. Plus promote-to-venture closes the
last note-viewer seam. `cargo check` clean (0 errors, 2 pre-existing
warnings in unrelated modules), full TS typecheck clean,
vault-runner's 12 tests still pass.

### Slice 1 — SQLite migration + vault job-store IPC

**Critical pre-existing bug fixed.** The DREAM_VAULT arc landed its
schema as [`packages/db/src/migrations/0002-vault.sql`](packages/db/src/migrations/),
but the Tauri app loads its migrations from a completely separate tree
at [`apps/founder-desktop/src-tauri/migrations/`](apps/founder-desktop/src-tauri/migrations/)
via `include_str!` macros in `lib.rs`. The npm-package directory was
unread by Tauri. **No vault table existed on disk before this slice.**
Nobody caught it because every TS code path was in-memory.

Fix:

- Deleted the dead duplicate at `packages/db/src/migrations/0002-vault.sql`
  (the npm `@founder-os/db` package already had the SQL inlined as a
  `MIGRATION_0002_VAULT` constant in `index.ts`, so the disk file
  served no consumer).
- Created [`apps/founder-desktop/src-tauri/migrations/0012-vault.sql`](apps/founder-desktop/src-tauri/migrations/0012-vault.sql) (144 LOC) — same 9 tables verbatim.
- Registered as `version: 12` in [`lib.rs`](apps/founder-desktop/src-tauri/src/lib.rs)'s `migrations()` function.

**New Rust module** [`vault.rs`](apps/founder-desktop/src-tauri/src/vault.rs) (~360 LOC) — 7 Tauri commands following
[`brand_names.rs`](apps/founder-desktop/src-tauri/src/brand_names.rs)'s lazy-WAL pattern:

| Command | TS contract |
| --- | --- |
| `vault_create_job(job)` | `ImportJobStore.insertJob` |
| `vault_update_job_status(jobId, status, errorMessage?, now)` | `.updateJobStatus` |
| `vault_get_job(jobId) -> ImportJob \| null` | `.getJob` |
| `vault_increment_job_counts(jobId, delta, now)` | `.incrementCounts` |
| `vault_insert_source(doc)` | `.insertSource` |
| `vault_list_sources_for_job(jobId) -> [SourceDocument]` | `.listSourcesForJob` |
| `vault_list_jobs(status?, limit?) -> [ImportJob]` | slice-4 boot probe |

`VaultState` is a `Mutex<Option<Connection>>` lazily initialised on
first command call — same pattern as `cache.rs` + `brand_names.rs` so
neither feature can starve the other on the lock. WAL is sticky on
disk so re-applying on every open is a no-op.

**TS-side glue.** New `createSqliteJobStore()` factory in
[`apps/founder-desktop/src/features/vault/run-vault-import.ts`](apps/founder-desktop/src/features/vault/run-vault-import.ts).
Probes at construction with a sentinel `vault_get_job` + `vault_list_jobs({limit:0})`
pair — when both `safeInvoke`s return null, the factory returns `null`
and the runner falls back to `createMemoryJobStore` for that run. The
probe-once design means a single "Rust ready?" boolean drives the
whole run; no half-persisted state.

### Slice 2 — Filesystem foundation

New crate dep: `sha2 = "0.10"` (pure-Rust, no native deps).

**New Rust module** [`vault_fs.rs`](apps/founder-desktop/src-tauri/src/vault_fs.rs) (~220 LOC) — 4 commands:

| Command | What it does |
| --- | --- |
| `vault_hash_file(absolutePath) -> String` | Streaming SHA-256 in 64 KiB chunks so multi-GB files don't blow up the heap. Returns lowercase hex. |
| `vault_read_file_bytes(absolutePath) -> Vec<u8>` | Full file bytes; serialized as a JSON number array by Tauri's bridge. The renderer's `new Uint8Array(result)` path already expected this shape. |
| `vault_stage_file({ absolutePath, workspaceRoot, hash, extension? }) -> StagedFile` | Copy original → `<workspaceRoot>/_vault/_import-cache/<hash-prefix>/<hash-rest>.<ext>`. Idempotent when target already exists. |
| `vault_save_pasted_blob({ workspaceRoot, text, title? }) -> StagedFile` | Hash paste text + write to import cache. Mirrors `vault_stage_file`'s envelope so the runner treats paste + file sources identically downstream. |

`StagedFile` envelope `{ cachedRelativePath, absolutePath, contentHash, byteSize }`
shared by both stage commands. Cache-path helper `cache_relative_path(hash, ext?)`
produces the same string the TS-side synthetic fallback computes, so
the slice-9 stub path and the slice-2 real path arrive at the same
place — important because the runner's `resolveCachedPath()` joins
the same string with `workspaceRoot` to compute the read target.

**TS staging loop rewritten** in
[`run-vault-import.ts`](apps/founder-desktop/src/features/vault/run-vault-import.ts) — three branches (paste / Drive / local file) replace
the single hash-then-fake-path block:

- **Local file**: `vault_hash_file` → `vault_stage_file`. Both calls
  via `safeInvoke`, fall back to slice-9 synthetic hash + path when
  the Rust side isn't built.
- **Paste**: `vault_save_pasted_blob` with the text from
  `globalThis.__VAULT_PASTES__`. Replaces the synthetic
  `__paste__/<id>.txt` path with the real cached path. The
  globalThis Map remains the renderer-side carrier; the Rust call
  materialises the bytes on disk.
- **Drive**: unchanged — slice 11 of the previous arc already had the
  Drive client write into the cache via `gdrive_download_file` /
  `gdrive_export_doc`. Drive IPC remains deferred.

### Slice 3 — Document extraction (PDF + DOCX via Node sidecar)

**New Rust module** [`vault_extract.rs`](apps/founder-desktop/src-tauri/src/vault_extract.rs) (~210 LOC) — 2 commands:

- **`vault_extract_pdf({ absolutePath }) -> { markdown, pageCount }`** — pure
  Rust via `pdf-extract` (already a dep, used by `pdf.rs` for chat
  attachments). Panic-guarded with `catch_unwind` because malformed
  PDFs can panic the crate. Page count approximated by counting
  `\u{c}` form-feed chars that pdf-extract injects between pages; 0
  for empty extractions (which the TS-side maps to
  `extractionMethod: "scanned_pdf_needs_ocr"`).
- **`vault_extract_docx({ absolutePath }) -> { markdown, warnings[] }`** — spawns
  the Node sidecar (see below) via
  `pnpm --filter @founder-os/document-extractor cli -- extract-docx --abs <path>`,
  parses the JSON envelope off the last non-empty stdout line. Same
  pattern as `backend.rs` slice 5b (the canonical pnpm-CLI sidecar
  precedent). 60s timeout.

Workspace-root + pnpm-resolver helpers (`find_workspace_root`,
`walk_up_for_marker`) duplicated locally from `backend.rs` —
backend.rs keeps them private and a tiny indirection isn't worth a
shared module for one new call site.

**New Node sidecar CLI** at
[`packages/document-extractor/src/cli.ts`](packages/document-extractor/src/cli.ts).
Subcommand `extract-docx --abs <path>` reads the file with
`fs.readFile`, runs the existing `createMammothTextExtractor()`,
emits a single-line `{ markdown, warnings[] }` JSON envelope. Error
path mirrors backend-providers' CLI (`{ error }` on stdout + non-zero
exit). New `cli` npm script + `tsx` devDep + `bin` entry in
[`packages/document-extractor/package.json`](packages/document-extractor/package.json).

**Why PDF + DOCX took different paths.** PDF has a mature pure-Rust
crate; DOCX doesn't, and `mammoth` is a long-standing npm package with
field-tested DOCX handling. The ~200 ms pnpm-spawn cost is worth it
for the maturity gap. Per-arc consistency wasn't worth eating that
maturity cost both ways.

**No TS changes needed for this slice** — the renderer's
`documentPort` (lines around `run-vault-import.ts:155-200`) already
calls `vault_extract_pdf` + `vault_extract_docx` via `safeInvoke`
(slice 9 of the vault arc wired them as stubs). The Rust response
shapes match what the renderer expects, so once the binary is
rebuilt, PDF + DOCX imports flow end-to-end.

### Slice 4 — Renderer hydration on boot

A new failure mode emerges once SQLite is the source of truth: a
crash or reload during a pending review used to drop everything (the
runner state was renderer-only); now the SQLite job + source rows
survive but the in-memory drafts/matches/items don't. Slice 4
surfaces this as **recovered entries**.

**New Rust command** `vault_discard_job(jobId)` in
[`vault.rs`](apps/founder-desktop/src-tauri/src/vault.rs) — transactional delete of source rows + the job row in
that order (the FK has no `ON DELETE CASCADE`). Idempotent — discarding
a stale id is a no-op success.

**New TS type** `RecoveredVaultImport` in
[`features/vault/types.ts`](apps/founder-desktop/src/features/vault/types.ts). Distinct from `PendingVaultImport`
because:
- No `RunVaultImportResult` (no `finalize()` to call).
- No drafts, matches, or extracted items — those weren't persisted.
- Only action available: discard.

**New module** [`features/vault/boot-hydration.ts`](apps/founder-desktop/src/features/vault/boot-hydration.ts):
- `hydrateRecoveredVaultJobs()` queries `vault_list_jobs("needs_review")` +
  per-job `vault_list_sources_for_job(id)` and returns a
  `Map<jobId, RecoveredVaultImport>`.
- `discardRecoveredVaultJob(jobId)` hits the new Rust command.
- Both fail-soft when commands aren't registered.

**Renderer wiring.** New `recoveredVaultImports` state in
[`App.tsx`](apps/founder-desktop/src/app/App.tsx) with a boot
`useEffect` that populates it (fire-and-forget, doesn't gate hydrate
of ventures). New `handleDiscardRecovered` callback.

**Panel extension.** `VaultPendingImportsPanel` accepts a new
`recovered` + `onDiscardRecovered` pair. Recovered entries render as
a `RecoveredVaultImportRow` with a distinctive dashed "recovered"
badge, creation timestamp, source count, an explanatory line
("Drafts + matches from this job's review aren't persisted yet —
discard and re-run to review."), and a Discard-only action set.
`DreamVaultBrowser` + `DreamVaultOverview` + `WelcomeScreen` all
forward the new props.

**Out of scope, surfaced as a follow-up.** Persisting drafts /
matches / items so a true resume is possible. Migration 0012 has the
tables (`vault_project_matches`, `vault_extracted_items`,
`vault_notes`) but the runner doesn't write to them today — drafts
stay transient until the markdown_path lands at commit time. A future
arc could write drafts to a new `vault_note_drafts` table at the
end of `run()` and rehydrate them on boot.

### Slice 5 — Promote-to-venture + final verification

**No new Rust** — composes the desktop's existing `read_file` +
`mkdir_p` + `write_file` commands in lib.rs. Vault notes are UTF-8
markdown so the round-trip is byte-exact.

**New TS module** [`features/vault/promote-to-venture.ts`](apps/founder-desktop/src/features/vault/promote-to-venture.ts):
- `promoteNoteToVenture({ sourceAbsolutePath, ventureRoot, draft })` →
  reads source → ensures parent dir → writes target.
- Target layout: `<ventureRoot>/_imports-from-vault/<noteId>__<slug>.md`.
- One flat bucket per venture. Splaying notes across the existing
  numbered-folder tree (`00_brief`, `10_research`, `20_brand`, ...)
  is a per-venture mapping decision the founder should drive
  manually rather than via a hard-coded `VaultNoteType` → folder
  table — too speculative without a canonical mapping. The
  `_imports-from-vault/` folder is the seam; once a venture's owner
  moves a note to the right slot, this code never touches it again.

**Note-viewer wired.** [`DreamVaultNoteViewer`](apps/founder-desktop/src/features/vault/screens/DreamVaultNoteViewer.tsx)'s
"Promote to venture" button now active when `committedAbsolutePath`
is set AND an `activeVenture` is selected. Disabled state remains
when either is missing, with explanatory toasts. Success toast
includes the venture name + the relative path so the user knows where
to find the imported note. `activeVenture` threaded through
`DreamVaultBrowser` from `App.tsx`.

---

## Architectural decisions worth flagging

### 1. The `safeInvoke` degradation pattern stays

Even with every command shipped, `safeInvoke` doesn't go away — it's
how the renderer keeps working in dev builds where the Tauri binary
hasn't been rebuilt against the latest Rust changes. The probe-once
design in `createSqliteJobStore` is the canonical pattern: one boolean
decision at the start, no half-persisted runs.

### 2. The migration fix is the most important change in the arc

If the Rust IPC arc had landed without renumbering the migration to
`0012-vault.sql` and registering it in `lib.rs`'s `migrations()`,
every new vault command would fail on first SQL touch ("no such
table: vault_import_jobs"). Slice 1 of the *previous* arc filed the
migration in the wrong directory; nobody noticed because the
renderer was 100% stubbed. This is the kind of cross-arc bug that's
trivially preventable with a smoke test at the SQL layer but
catastrophic in production — flag for the verification-loop arc.

### 3. Node sidecar for DOCX, not Rust crate

Per the user's explicit Q2 answer at arc start. Trade-off: ~200 ms
pnpm-spawn cost per DOCX vs picking a less-mature Rust DOCX crate.
Field-tested `mammoth` wins on the import path where reliability
matters more than throughput (one DOCX per source, not bulk).

### 4. Recovered entries are awareness-only, not resumable

Slice 4 ships *awareness* that pending reviews from a previous
session exist + a clean discard. Resumable review requires persisting
drafts/matches/items (~all the runner state) which is its own arc.
Today's recovered entries pin the SQLite rows; the user discards them
and re-runs to review.

### 5. Drive OAuth is unchanged

Drive picker still renders the "Drive IPC pending" banner. None of
the 9 Drive commands shipped in this arc. Per the user's directive
("no oauth do later"). The TS surface from vault-arc slice 5 + 11 is
already in place; whenever Drive ships it slots in cleanly behind
`DriveCommandNotWiredError`.

---

## File summary

### New Rust files

- [`apps/founder-desktop/src-tauri/migrations/0012-vault.sql`](apps/founder-desktop/src-tauri/migrations/0012-vault.sql) — 144 LOC
- [`apps/founder-desktop/src-tauri/src/vault.rs`](apps/founder-desktop/src-tauri/src/vault.rs) — 388 LOC, 8 commands
- [`apps/founder-desktop/src-tauri/src/vault_fs.rs`](apps/founder-desktop/src-tauri/src/vault_fs.rs) — 222 LOC, 4 commands
- [`apps/founder-desktop/src-tauri/src/vault_extract.rs`](apps/founder-desktop/src-tauri/src/vault_extract.rs) — 209 LOC, 2 commands

### Modified Rust files

- [`apps/founder-desktop/src-tauri/Cargo.toml`](apps/founder-desktop/src-tauri/Cargo.toml) — `sha2 = "0.10"` added
- [`apps/founder-desktop/src-tauri/src/lib.rs`](apps/founder-desktop/src-tauri/src/lib.rs) — 4 new mod statements, 14 new entries in `invoke_handler!`, 1 new `.manage()`, migration 12 entry

### New TS files

- [`apps/founder-desktop/src/features/vault/boot-hydration.ts`](apps/founder-desktop/src/features/vault/boot-hydration.ts) — slice 4 boot probe + discard
- [`apps/founder-desktop/src/features/vault/promote-to-venture.ts`](apps/founder-desktop/src/features/vault/promote-to-venture.ts) — slice 5 composer
- [`packages/document-extractor/src/cli.ts`](packages/document-extractor/src/cli.ts) — slice 3 Node sidecar

### Modified TS files

- [`apps/founder-desktop/src/features/vault/run-vault-import.ts`](apps/founder-desktop/src/features/vault/run-vault-import.ts) — slices 1 + 2 (SQLite store, staging loop)
- [`apps/founder-desktop/src/features/vault/types.ts`](apps/founder-desktop/src/features/vault/types.ts) — slice 4 `RecoveredVaultImport`
- [`apps/founder-desktop/src/features/vault/VaultPendingImportsPanel.tsx`](apps/founder-desktop/src/features/vault/VaultPendingImportsPanel.tsx) — slice 4 recovered rendering
- [`apps/founder-desktop/src/features/vault/DreamVaultBrowser.tsx`](apps/founder-desktop/src/features/vault/DreamVaultBrowser.tsx) — slice 5 activeVenture
- [`apps/founder-desktop/src/features/vault/screens/DreamVaultNoteViewer.tsx`](apps/founder-desktop/src/features/vault/screens/DreamVaultNoteViewer.tsx) — slice 5 promote
- [`apps/founder-desktop/src/features/vault/screens/DreamVaultOverview.tsx`](apps/founder-desktop/src/features/vault/screens/DreamVaultOverview.tsx) — slice 4 recovered forwarding
- [`apps/founder-desktop/src/app/App.tsx`](apps/founder-desktop/src/app/App.tsx) — slices 4 + 5 state + callbacks
- [`apps/founder-desktop/src/app/WelcomeScreen.tsx`](apps/founder-desktop/src/app/WelcomeScreen.tsx) — slice 4 panel props
- [`packages/document-extractor/package.json`](packages/document-extractor/package.json) — slice 3 cli script + tsx + bin

### Deleted files

- `packages/db/src/migrations/0002-vault.sql` (dead duplicate)

Rough total: ~960 LOC of new Rust, ~360 LOC of TS changes (new + edits).

---

## Suggested commit split

6 commits, one per slice + the SHIP-NOTES:

1. `feat(vault-rust): slice 1 — SQLite migration fix + vault job-store IPC`
   - Move `packages/db/src/migrations/0002-vault.sql` → `apps/founder-desktop/src-tauri/migrations/0012-vault.sql`
   - `apps/founder-desktop/src-tauri/src/vault.rs` (new)
   - `apps/founder-desktop/src-tauri/src/lib.rs` (mod + manage + invoke_handler + migrations array)
   - `apps/founder-desktop/src/features/vault/run-vault-import.ts` (createSqliteJobStore factory)

2. `feat(vault-rust): slice 2 — filesystem foundation (hash, stage, paste blob)`
   - `apps/founder-desktop/src-tauri/Cargo.toml` (sha2 dep)
   - `apps/founder-desktop/src-tauri/src/vault_fs.rs` (new)
   - `apps/founder-desktop/src-tauri/src/lib.rs` (4 new invoke_handler entries)
   - `apps/founder-desktop/src/features/vault/run-vault-import.ts` (3-branch staging loop)

3. `feat(vault-rust): slice 3 — document extraction (PDF + DOCX via Node sidecar)`
   - `apps/founder-desktop/src-tauri/src/vault_extract.rs` (new)
   - `apps/founder-desktop/src-tauri/src/lib.rs` (2 new invoke_handler entries)
   - `packages/document-extractor/src/cli.ts` (new)
   - `packages/document-extractor/package.json` (cli script + tsx + bin)
   - `pnpm-lock.yaml`

4. `feat(vault-rust): slice 4 — renderer hydration on boot from SQLite`
   - `apps/founder-desktop/src-tauri/src/vault.rs` (vault_discard_job)
   - `apps/founder-desktop/src-tauri/src/lib.rs` (1 new invoke_handler entry)
   - `apps/founder-desktop/src/features/vault/boot-hydration.ts` (new)
   - `apps/founder-desktop/src/features/vault/types.ts` (RecoveredVaultImport)
   - `apps/founder-desktop/src/features/vault/VaultPendingImportsPanel.tsx`
   - `apps/founder-desktop/src/features/vault/DreamVaultBrowser.tsx` (recovered fwd)
   - `apps/founder-desktop/src/features/vault/screens/DreamVaultOverview.tsx`
   - `apps/founder-desktop/src/app/App.tsx` (state + boot effect)
   - `apps/founder-desktop/src/app/WelcomeScreen.tsx`

5. `feat(vault-rust): slice 5 — promote-to-venture composer`
   - `apps/founder-desktop/src/features/vault/promote-to-venture.ts` (new)
   - `apps/founder-desktop/src/features/vault/screens/DreamVaultNoteViewer.tsx`
   - `apps/founder-desktop/src/features/vault/DreamVaultBrowser.tsx` (activeVenture pass-through)
   - `apps/founder-desktop/src/app/App.tsx` (activeVenture prop)

6. `docs(vault-rust): SHIP-NOTES + commit split`
   - `bizBuild/DREAM-VAULT-RUST-IPC-SHIP-NOTES.md`

---

## Smoke-test checklist

Run on a Windows dev box with the Tauri binary freshly rebuilt:

1. **Boot a fresh workspace.** Confirm `founder.db` gets migration 12
   applied — check by opening the file in any SQLite browser, all 9
   `vault_*` tables should be present.
2. **Local file import.** Pick a `.txt`, `.md`, `.json`. Confirm the
   files actually land at `<workspaceRoot>/_vault/_import-cache/<2chars>/<rest>.<ext>`.
3. **PDF import.** Pick a text-extractable PDF + a scanned PDF. The
   text PDF should produce `extractionMethod: "pdf_text"` with a
   reasonable markdown blob; the scanned one should produce
   `extractionMethod: "scanned_pdf_needs_ocr"` + empty markdown.
4. **DOCX import.** Pick a DOCX with mixed formatting. Sidecar should
   fire (look for the ~200ms pnpm spawn in dev console). Markdown
   should round-trip the document's text.
5. **Paste import.** Paste a chat transcript. Confirm a file lands at
   `_vault/_import-cache/<2chars>/<rest>.txt` containing the paste.
6. **Reload mid-review.** Trigger a pending review (any provider).
   Don't commit. Reload the app. The pending row should reappear in
   `VaultPendingImportsPanel` with a dashed "recovered" badge. Click
   Discard → row goes away + the SQLite job + source rows are gone
   (check via DB browser).
7. **SQLite store survives reload.** Trigger an import, commit it,
   reload. The recovered panel should be empty (committed jobs aren't
   `needs_review`). Query `SELECT * FROM vault_import_jobs WHERE
   status = 'committed'` — should see the row.
8. **Promote to venture.** Trigger an import targeted at an active
   venture, commit it. Open the Dream Vault browser → click into a
   note → Promote to venture. Confirm
   `<ventureRoot>/_imports-from-vault/<noteId>__<slug>.md` exists with
   the note content.
9. **Pre-existing flows still work.** Confirm New Venture wizard,
   stage runs, brand-name generation, handoff watcher are all
   untouched (this arc doesn't touch any of those modules; smoke for
   regressions).
10. **Drive picker.** Still shows "Drive IPC pending" banner. No
    regressions.

---

## Verification at ship time

- `cargo check` in `apps/founder-desktop/src-tauri/` → **0 errors**
  (2 pre-existing warnings in `cli_agent.rs` + `handoff_watcher.rs`
  unrelated to this arc; verify via `git diff HEAD --` empty on those
  files).
- `pnpm --filter founder-desktop typecheck` → clean.
- `pnpm --filter @founder-os/document-extractor typecheck` → clean.
- `pnpm --filter @founder-os/vault-runner test` → 12/12 pass.

The pre-existing pre-vault-arc parse error in
`packages/media-providers/src/cli.ts:375-376` (called out in the
DREAM-VAULT SHIP-NOTES) is still on `main` and still out of scope —
do not bundle its fix with this arc.

---

## Carry-over: follow-up arcs

Three concrete next arcs the Rust IPC unlocks:

1. **Drive OAuth + listing + transfers** — the 9 commands from
   spec §3 slice 5 of the vault arc. Token via `keyring` crate
   (already in deps via `secrets.rs`). Loopback listener pattern
   exists in `cli_agent.rs::cli_agent_login` to crib from. Scopes
   `drive.readonly` + `drive.metadata.readonly`. Drive client-id
   needs Google Cloud Console provisioning by the user before this
   arc can ship.

2. **Drafts/items/matches persistence** — adds writes to
   `vault_project_matches`, `vault_extracted_items`, and a new
   `vault_note_drafts` table at the end of `runner.run()`. Boot
   hydration then rebuilds the full `RunVaultImportResult` from
   SQLite + a synthetic `finalize()` that resumes against the live
   `markdown-vault` fs port. Makes recovered entries truly
   resumable (today they can only be discarded).

3. **Verification-loop check for migration drift** — the slice-1
   bug (vault migration filed in the wrong directory) is exactly
   the kind of cross-arc regression a smoke test could prevent. A
   tiny SQL probe on boot ("does `vault_import_jobs` exist after
   migrations apply?") wired into the verification-loop arc would
   trip loudly on similar misplacement bugs in future arcs.
