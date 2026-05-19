# Dream Vault — Ship Notes (2026-05-19)

The DREAM_VAULT_MODULE arc landed across 12 slices on top of `f7feb6f` (post deep-research). Everything is uncommitted on the working tree; the user decides the commit cadence + `--no-verify` policy at commit time per the existing convention.

The arc implements the full Dream Vault subsystem from spec `DREAM-VAULT-MODULE-SPEC.md`: a local-first, filesystem-backed vault that ingests AI chat exports, documents, images, and Google Drive files, runs them through an LLM-aware extraction + project-classification pipeline, and emits draft vault notes that the founder reviews + commits into either a venture-scoped tree or the workspace inbox. No REST routes, no public publishing, no auto-sync, no OAuth tokens in TypeScript memory.

---

## Arc footprint

- **11 new `@founder-os/*` packages** under `packages/`:
  - `vault-contract` (5 files, 530 LOC) — zod schemas, types
  - `import-core` (19 files, 1673 LOC) — job orchestration, hashing, dedupe, PM-split
  - `document-extractor` (19 files, 931 LOC) — pdf/docx/md/txt/html/csv/json, PM-split
  - `image-extractor` (13 files, 679 LOC) — EXIF + OCR + injected vision-LLM
  - `chat-importer` (16 files, 898 LOC) — ChatGPT / Claude / generic / paste, PM-split
  - `knowledge-extractor` (10 files, 805 LOC) — LLM-aware item extraction + deterministic fallback
  - `project-classifier` (10 files, 822 LOC) — LLM-aware venture matching + deterministic fallback
  - `markdown-vault` (16 files, 1717 LOC) — 11 note templates, frontmatter, sanitiser, fs port
  - `vault-runner` (14 files, 1926 LOC) — pipeline glue, validate→prepare→execute→finalize
  - `google-drive-importer` (7 files, 767 LOC) — typed wrappers over 9 Tauri commands, Workspace export router
  - `local-file-importer` (11 files, 532 LOC) — dialog-driven file/folder ingestion
- **17 new desktop files** under `apps/founder-desktop/src/features/vault/` (5,125 LOC):
  - Flow container: `VaultImportFlow.tsx` (state machine: hub | local | paste | drive | progress | review)
  - 10 screens: `VaultImportHubScreen` / `VaultImportLocalScreen` / `VaultImportPasteScreen` / `VaultImportDriveScreen` / `VaultImportProgressScreen` / `VaultImportReviewScreen`, plus `DreamVaultOverview` / `DreamVaultProjectPage` / `DreamVaultSourceViewer` / `DreamVaultNoteViewer`
  - 2 panels: `VaultPendingImportsPanel` (sister to `PendingReviewsPanel`), `HomeVaultButtons` (hero + compact variants)
  - 2 glue files: `run-vault-import.ts` (the runner-helper), `DreamVaultBrowser.tsx` (internal router host)
  - 2 client/types: `drive-client.ts` (Tauri-wrapping factory), `types.ts` (`PendingVaultImport` / `RecentVaultImport`)
- **SQLite migration** `packages/db/src/migrations/0002-vault.sql` (144 LOC) — 9 new tables per spec §4.
- **268 vitest tests** total across the 12 arc packages, all green:
  ```
  vault-contract       13 passed
  import-core          55 passed
  document-extractor   24 passed
  image-extractor      14 passed
  chat-importer        20 passed
  knowledge-extractor  24 passed
  project-classifier   19 passed
  markdown-vault       33 passed
  vault-runner         12 passed
  google-drive-importer 28 passed
  local-file-importer  15 passed
  workspace-core       11 passed   (vault-paths.test.ts additions)
  ```
- **8 existing files modified** (696 net new lines): `apps/founder-desktop/src/app/App.tsx`, `WelcomeScreen.tsx`, `packages/ui/src/sidebar.tsx`, `packages/db/src/migrations/index.ts`, `packages/db/src/schema/index.ts`, `tsconfig.base.json` (12 new path aliases), `apps/founder-desktop/package.json` (10 new deps), `biome.json` (path rule additions for new packages), `pnpm-lock.yaml`.

Rough arc total: **≈17,330 LOC** of new code + tests.

---

## Architectural decisions worth flagging

### 1. Renderer is Tauri-side, but every Rust call is wrapped in `safeInvoke`

Per spec §1.1, Founder OS is a Tauri desktop app with no HTTP server. All filesystem and Drive operations bottom out at Tauri commands. **The Rust side of those commands has not yet been implemented in this arc.** Every command call is wrapped:

- `apps/founder-desktop/src/features/vault/run-vault-import.ts:84` — `safeInvoke<T>` catches "command not registered" errors and returns `null`, letting the runner degrade to deterministic/needs-review behaviour.
- `apps/founder-desktop/src/features/vault/drive-client.ts` — `buildDriveClient()` wraps Tauri's real `invoke` and throws a typed `DriveCommandNotWiredError` when a Drive command isn't registered; the Drive screen catches this and renders a "Drive IPC pending" banner instead of crashing.

This means the renderer compiles cleanly, the typecheck is green, the UI runs end-to-end against in-memory stubs, and the arc is ready for the Rust IPC slice to be slotted in package-by-package without further TS changes.

### 2. Pending-imports state is renderer-only

Slice 9 + 10 keep `pendingVaultImports: Map<jobId, PendingVaultImport>` and `recentVaultImports: RecentVaultImport[]` in `App.tsx` state. The runner instance holds the `VaultRunResult` and the `finalize` callback in memory. Survives modal close/open within a session; lost on reload. The SQLite tables for both job + sources are created (migration 0002) but no IPC commands surface them to the renderer yet — that's the post-arc Rust work. The progress + review + browser surfaces all read from the in-memory maps.

### 3. LLM calls all route through the existing dispatcher

Per spec §1.2, no new package imports a provider SDK directly. `knowledge-extractor` and `project-classifier` take an injected `callLlm` whose shape matches `streamChat` from `apps/founder-desktop/src/lib/llm-client.ts`. The desktop wires `buildPipelineLlmCaller({ ventureId })` (subscription-first via local `claude` / `codex` / `gemini` CLIs; falls back to API keys; null → offline mode and the runner uses deterministic heuristics). The slice-9 `run-vault-import.ts` helper is the single point of LLM wiring; tests inject mocks.

The £5-surprise incident (2026-05-11) the spec calls out is structurally prevented: the offending pattern (`new Anthropic({ apiKey })` inside a non-desktop package) cannot land because the packages don't import any provider SDK.

### 4. Drive flow defers OAuth to Rust; tokens never touch TS

Per spec §1.6, `gdrive_*` commands run Rust-side. The TS `DriveClient` orchestrates the call sequence but never sees a token — only the `keyring` reference stored in `vault_cloud_connections.token_reference`. Read-only scopes are enforced by the OAuth start command (`drive.readonly` + `drive.metadata.readonly`) when slice-12-rust lands; the renderer just trusts the connection row.

### 5. `PendingReviewsPanel` reused as a pattern, not a file

Spec §1.7 says to use the existing `PendingReviewsPanel` pattern. The existing panel is venture-scoped (reads `_review_gates/` on disk, advances stage via `STAGE_PRODUCES`); vault imports are workspace-scoped and may not even have a venture picked yet. `VaultPendingImportsPanel.tsx` mirrors the visual treatment of the existing panel but takes its data from the App-level pending-imports map. Mounted on `WelcomeScreen` (so the founder sees their pending work even when no venture is active) and inside `DreamVaultBrowser`. Spec spirit honoured: same UX pattern, different data source.

### 6. Workspace-doc export decision lives in the package, not the runner

`pickWorkspaceExport` in `@founder-os/google-drive-importer` maps Google Workspace mimes to Office targets (Docs → docx, Sheets → xlsx, Slides → pptx, Drawings → png; Forms / Sites / Shortcuts → `null`, skipped). The runner's Drive fetch loop reads this and routes per-source. Keeping the table in the package keeps the runner agnostic of Drive specifics.

---

## Slice-by-slice summary

| Slice | Surface | Files | Tests | Notes |
| --- | --- | --- | --- | --- |
| 1 | `@founder-os/vault-contract` + SQLite migration 0002 + `workspace-core` path helpers | ~8 | 13 + 11 | Zod schemas for everything in spec §4. Frozen contracts the rest of the arc references. |
| 2 | `@founder-os/import-core` + `@founder-os/local-file-importer` | ~30 | 55 + 15 | PM-split. Failed-file isolation (`safelyRunPerFile`). Dedupe by content hash within and across jobs. |
| 3 | `@founder-os/document-extractor` + `@founder-os/image-extractor` | ~32 | 24 + 14 | Real fixture files; PDF text path returns `scanned_pdf_needs_ocr` for image-only PDFs. |
| 4 | `@founder-os/chat-importer` | ~16 | 20 | ChatGPT mapping-tree flattener; lenient Claude parser; generic transcript heuristic; paste detector. Failed conversation in a multi-conversation export doesn't fail the others. |
| 5 + 11 | `@founder-os/google-drive-importer` + Drive picker UI | ~9 (pkg + 2 desktop) | 28 | Slice 5 was deferred per the user's call at slice 9; landed together with slice 11. Workspace-doc export router lives in the package. Rust IPC stubbed via `DriveCommandNotWiredError`. |
| 6 | `@founder-os/knowledge-extractor` + `@founder-os/project-classifier` | ~20 | 24 + 19 | Both take injected `callLlm`. Deterministic fallback for offline mode: filename heuristics for title, all matches go to `unsorted` with `confidence: low`. |
| 7 | `@founder-os/markdown-vault` | ~16 | 33 | 11 handlebars-subset templates, frontmatter round-trip, markdown sanitiser, injectable fs port. |
| 8 | `@founder-os/vault-runner` | ~14 | 12 | Runner class mirroring `MediaStageRunner` shape: `validate→prepare→execute→finalize`. Drift-protected log strings in `VAULT_LOG_STRINGS`. Full pipeline + finalize coverage. |
| 9 | Desktop UI: home buttons, import wizard, progress | 9 files in `features/vault/` | (UI) | Three home buttons in the spec'd order. Modal-based flow (no router). In-memory ImportJobStore. Privacy banner mounted on every entry. |
| 10 | Desktop UI: review screen + vault browser | +8 files in `features/vault/` | (UI) | Review screen: approve / reject / venture-slug picker / warnings / Commit-to-vault CTA → `runner.finalize({ approvals, now })`. Vault browser: overview + project page + source viewer + note viewer; filters by source-type, provider, confidence, needs-review, unsorted. |
| 11 | Drive picker UI | +1 file (shared package above) | (UI) | Connect card with OAuth seam; search; folder breadcrumb; multi-select staging; privacy copy. Renders an explicit "Drive IPC pending" state when Rust isn't wired. |
| 12 | This ship-notes file | 1 file | — | Pure docs + verification step. |

---

## Suggested commit split

Each slice usually lands as one commit; slice 9/10 + slice 5/11 are bundled where the spec already grouped them.

1. `feat(vault): slice 1 — vault-contract package + SQLite migration + workspace-core path helpers`
   - `packages/vault-contract/**`, `packages/db/src/migrations/0002-vault.sql`, `packages/db/src/migrations/index.ts`, `packages/db/src/schema/index.ts`, `packages/workspace-core/src/paths.ts`, `packages/workspace-core/test/vault-paths.test.ts`, `packages/workspace-core/package.json`, `packages/workspace-core/tsconfig.json`, `packages/workspace-core/vitest.config.ts`, `tsconfig.base.json` (just the contract alias), `biome.json` (path-rule additions).

2. `feat(vault): slice 2 — import-core + local-file-importer with PM-split`
   - `packages/import-core/**`, `packages/local-file-importer/**`, plus the 4 path aliases in `tsconfig.base.json`.

3. `feat(vault): slice 3 — document-extractor + image-extractor`
   - `packages/document-extractor/**`, `packages/image-extractor/**`, plus 4 aliases in `tsconfig.base.json`.

4. `feat(vault): slice 4 — chat-importer (ChatGPT/Claude/generic/paste parsers)`
   - `packages/chat-importer/**`, plus 2 aliases in `tsconfig.base.json`.

5. `feat(vault): slice 6 — knowledge-extractor + project-classifier (LLM-aware + offline fallbacks)`
   - `packages/knowledge-extractor/**`, `packages/project-classifier/**`, plus 2 aliases in `tsconfig.base.json`.

6. `feat(vault): slice 7 — markdown-vault templates + fs port + sanitiser`
   - `packages/markdown-vault/**`, plus 1 alias in `tsconfig.base.json`.

7. `feat(vault): slice 8 — vault-runner (pipeline glue + finalize)`
   - `packages/vault-runner/**`, plus 1 alias in `tsconfig.base.json`.

8. `feat(vault): slice 9 — desktop UI (home buttons + import wizard + progress)`
   - `apps/founder-desktop/src/features/vault/{run-vault-import.ts, VaultImportFlow.tsx, HomeVaultButtons.tsx, DreamVaultBrowser.tsx, types.ts}` plus `screens/{VaultImportHubScreen, VaultImportLocalScreen, VaultImportPasteScreen, VaultImportProgressScreen}.tsx`, `apps/founder-desktop/src/app/App.tsx`, `WelcomeScreen.tsx`, `packages/ui/src/sidebar.tsx`, `apps/founder-desktop/package.json` (deps for 9 packages so far), `pnpm-lock.yaml`.

9. `feat(vault): slice 10 — review screen + vault browser body + pending-imports panel`
   - `apps/founder-desktop/src/features/vault/{VaultPendingImportsPanel.tsx, screens/VaultImportReviewScreen.tsx, screens/DreamVaultOverview.tsx, screens/DreamVaultProjectPage.tsx, screens/DreamVaultSourceViewer.tsx, screens/DreamVaultNoteViewer.tsx}` + the App.tsx / DreamVaultBrowser.tsx wiring deltas.

10. `feat(vault): slice 5 + 11 — Google Drive picker (package + desktop screen)`
    - `packages/google-drive-importer/**`, `apps/founder-desktop/src/features/vault/{drive-client.ts, screens/VaultImportDriveScreen.tsx}`, hub-screen + flow + run-vault-import + progress-screen deltas, `apps/founder-desktop/package.json` (10th dep), `tsconfig.base.json` (final alias), `pnpm-lock.yaml`.

11. `docs(vault): slice 12 — DREAM-VAULT-SHIP-NOTES`
    - `bizBuild/DREAM-VAULT-SHIP-NOTES.md`.

Slice 5 + 11 are bundled because slice 5 was deferred at slice 9 ("§8 Q2 — drop slice 5 + slice 11 and ship in ~9 slices if local-only enough") and un-deferred at slice 11. They share the same package so splitting them would mean two commits to the same `packages/google-drive-importer/` tree — net negative for review hygiene.

If `--no-verify` is needed: the pre-commit hook is strict per the existing convention. Hand-rolling the hook bypass is user-side; don't auto-do this.

---

## Smoke-test checklist

Run on a fresh dev session against an active venture:

1. **Sidebar + welcome** — both render the three home buttons in spec order (`Import AI Chats & Docs` / `New Venture` / `View Dream Vault`).
2. **Local file import** — open the flow → Local Files → pick a `.md` + a `.txt` + a `.json` → Start Import → progress screen runs all 9 phases → status reaches `needs_review`. With no LLM provider, classifier + knowledge-extractor use deterministic fallbacks (all sources route to Unsorted; matches show `low` confidence).
3. **Paste flow** — pick Paste → type a chat-shaped transcript (`User:` / `Assistant:`) → Start Import → verify the chat-importer parser was picked (not generic doc).
4. **Drive flow IPC-pending state** — pick Google Drive → the Connect card renders the dashed "Drive IPC pending" banner with the slice-12 carry-over note. (No crash; clean degrade.)
5. **Ready-for-review handoff** — once a progress run reaches `needs_review`, the modal shows `Review imports →` and `Review later` buttons. Clicking "Review later" closes the modal; reopening the home screen surfaces a row in `VaultPendingImportsPanel`.
6. **Review screen actions** — open a pending import → approve some, reject one, route at least one to a venture and at least one to Unsorted → Commit to Dream Vault. The toast reports counts; the run moves from pending to recent.
7. **Vault browser** — `View Dream Vault` → Recent imports lists the committed run; Sources section filtered by `Type: document` shows the staged sources; clicking a source opens the source viewer; clicking a draft opens the note viewer with frontmatter + content preview.
8. **Offline LLM path** — repeat (2) with `claude` / `codex` / `gemini` CLI absent and API key cleared; the run completes via deterministic heuristics and the offline badge appears on the pending row.
9. **Privacy copy** — verify the banner appears at the top of every entry screen (Local, Paste, Drive, Vault Browser overview).
10. **Sidebar + Welcome reskin** — confirm the slice-9 reskin still renders cleanly when no ventures exist (Welcome hero) and when an active venture is selected (sidebar compact variant).

---

## Carry-over: Rust IPC (post-arc work)

The TS surface is complete; the Rust side is its own follow-up arc. Every consumer call site is already in place, gated behind `safeInvoke` / `DriveCommandNotWiredError`. Rust commands to register, grouped by area:

**Filesystem (called from `run-vault-import.ts`):**
- `vault_hash_file({ absolutePath }) -> string` — sha-256 of the file contents.
- `vault_stage_file({ absolutePath, workspaceRoot, hash, extension? })` — copy into `_vault/_import-cache/<hash-prefix>/<hash-rest>.<ext>`.
- `vault_read_file_bytes({ absolutePath }) -> number[]` — used by every extractor port.
- `vault_extract_pdf({ absolutePath }) -> { markdown, pageCount }` — pdfjs-dist or equivalent.
- `vault_extract_docx({ absolutePath }) -> { markdown, warnings[] }` — mammoth.
- `vault_save_pasted_blob({ jobId, text, title? }) -> absolutePath` — writes paste content into the cache so the renderer doesn't need `globalThis.__VAULT_PASTES__` glue.

**SQLite (currently shadowed by in-memory stores):**
- `vault_create_job(...) / vault_update_job_status / vault_insert_source / vault_list_jobs / vault_get_job / vault_list_sources_for_job` — wraps the 9 tables migration 0002 created.
- Persisting pending imports across reloads — once these land, `App.tsx`'s `pendingVaultImports` map gets hydrated from SQLite on boot.

**Google Drive (9 commands per spec §3 slice 5 + 2 additions):**
- `gdrive_start_oauth -> { consentUrl, state, loopbackPort }`
- `gdrive_complete_oauth({ state }) -> { connection }`
- `gdrive_get_connection -> DriveConnection | null`
- `gdrive_disconnect({ connectionId })`
- `gdrive_list_recent({ connectionId, pageSize })`
- `gdrive_search({ connectionId, query, pageSize })`
- `gdrive_list_folder({ connectionId, folderId, pageSize })`
- `gdrive_download_file({ connectionId, fileId, workspaceRoot }) -> DriveDownloadResult`
- `gdrive_export_doc({ connectionId, fileId, exportMimeType, workspaceRoot }) -> DriveDownloadResult`
- Tokens via `keyring` crate; `vault_cloud_connections.token_reference` holds the keychain key. Scopes: `drive.readonly` + `drive.metadata.readonly` only.

**Promote-to-venture (slice-10 stub on the note viewer):**
- The slice-10 note viewer has a `Promote to venture` button that currently toasts "lands with the Rust IPC in slice 12". The flow needs:
  1. Read the committed vault note from `_vault/projects/<slug>/...` (via `vault_read_file_bytes`).
  2. Pick the target venture's numbered folder (`getVentureRoot()` + the existing venture path helpers).
  3. Write the note's body into the right artefact slot.
  - This is a small composition once vault_read_file_bytes is wired; no further TS work needed.

---

## Pre-existing issue surfaced (out of arc scope)

`pnpm -r typecheck` against the whole workspace fails at `packages/media-providers/src/cli.ts:375-376`:

```
src/cli.ts(375,2): error TS1005: ';' expected.
src/cli.ts(376,1): error TS1128: Declaration or statement expected.
```

Lines 375–376 contain stray fragments (`1);\n});`) outside the `main().catch(...)` block. `git diff HEAD -- packages/media-providers/src/cli.ts` is empty — these lines are on `main` and untouched by this arc. The Dream Vault arc's own packages all typecheck and test cleanly:

```
pnpm --filter @founder-os/{vault-contract,import-core,document-extractor,image-extractor,
                            chat-importer,knowledge-extractor,project-classifier,markdown-vault,
                            vault-runner,google-drive-importer,local-file-importer,workspace-core}
       --filter founder-desktop typecheck      # all green
       (and `test`, 268 passed)
```

The media-providers parse error should be fixed in a separate commit (it's a one-line cleanup — delete lines 375–376). Out of scope for this arc.

---

## Verification at ship time

- `pnpm --filter founder-desktop typecheck` — green.
- `pnpm --filter @founder-os/{vault-contract,import-core,document-extractor,image-extractor,chat-importer,knowledge-extractor,project-classifier,markdown-vault,vault-runner,google-drive-importer,local-file-importer,workspace-core} typecheck` — green.
- Same filter applied to `test` — **268/268 pass**.
- Spec §6 non-goals all upheld:
  - No public publishing of vault notes (no surface offers it).
  - No automatic Drive sync (the Drive screen is read-on-demand only).
  - No automatic re-import of already-committed sources.
  - No deletion of source files outside the vault.
  - No raw OAuth tokens in SQLite (the migration stores `token_reference`, not `token`).
  - No LLM call that bypasses `streamChat` / `callLlm` injection.
  - No `node:*` imports in `apps/founder-desktop/src` (biome rule enforced; PM-split applied to every package that needs Node).
