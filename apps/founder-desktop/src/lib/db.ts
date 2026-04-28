import type { ChatMessage } from "@founder-os/chat-ui";
import type { Venture, VentureStage } from "@founder-os/domain";
import { type LlmProviderId, getProvider } from "@founder-os/llm-providers";
import { invoke } from "@tauri-apps/api/core";
/**
 * Thin SQLite wrapper over `@tauri-apps/plugin-sql`.
 * The DB file lives in the app's data dir as `founder.db` (auto-resolved
 * by the plugin when we use the `sqlite:` prefix).
 *
 * Migrations are applied by the Rust side at plugin init
 * (see `src-tauri/src/lib.rs` → `migrations()`), so by the time any
 * code here runs the schema is guaranteed to exist.
 */
import Database from "@tauri-apps/plugin-sql";
import { pushToast } from "./toasts.js";

/** Resolve a provider's default model from the catalog, or a safe empty
 *  fallback if the id is unknown. Used by `upsertLlmSetting` so a caller
 *  can insert a row without having to import the catalog themselves —
 *  which matters for subscription-mode flips where the CLI picks the
 *  model internally and the DB value is essentially a placeholder. */
function defaultModelFor(providerId: string): string {
  try {
    return getProvider(providerId as LlmProviderId).defaultModel;
  } catch {
    // Unknown id — return an empty string rather than throwing; the
    // `model` column is NOT NULL but accepts empty strings. If the
    // provider doesn't exist in the catalog the user can't actually use
    // it anyway, so the stored value is moot.
    return "";
  }
}

/** Short human string for error toasts — stringify errors cleanly. */
function errDetail(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ──────────────────────────────────────────────
// Secret storage (OS keychain)
// ──────────────────────────────────────────────
// API keys live in the OS credential store, NOT in SQLite. The `api_key`
// column on `llm_settings` is retained only as a legacy migration path —
// `getLlmSetting` moves any stray plaintext value into the keychain the
// first time it's read and nulls the column.

async function keyringGet(provider: string): Promise<string | null> {
  try {
    return (await invoke<string | null>("keyring_get", { provider })) ?? null;
  } catch (err) {
    // If the keyring backend is unavailable (headless Linux without
    // secret-service, etc.) we return null and let the caller fall back
    // to the SQLite plaintext column. Log + toast so the user knows why
    // their key can't be found. Dedupe-by-message in the toast store
    // stops this spamming when N providers fail in the same session.
    console.warn("[keyring] get failed", err);
    pushToast({
      kind: "warn",
      message: "Couldn't read API key from OS keychain",
      detail: `${provider}: ${errDetail(err)}`,
    });
    return null;
  }
}

/**
 * Write a secret to the OS keychain. Throws on failure.
 *
 * `silent: true` suppresses the error toast — used by the passive
 * plaintext→keychain migration in `resolveApiKey`, where the user
 * didn't initiate a save and a toast saying "couldn't save" would be
 * confusing. Caller still gets the thrown error to handle its own
 * fallback (keep the plaintext row around, retry next time).
 */
async function keyringSet(
  provider: string,
  secret: string,
  opts: { silent?: boolean } = {}
): Promise<void> {
  try {
    await invoke("keyring_set", { provider, secret });
  } catch (err) {
    // User-initiated saves get a sticky error toast — this is a real
    // data-loss risk because the caller assumed the key was saved. The
    // passive migration path sets `silent: true` because it has its own
    // plaintext-fallback safety net.
    console.error("[keyring] set failed", err);
    if (!opts.silent) {
      pushToast({
        kind: "error",
        message: "Couldn't save API key to OS keychain",
        detail: `${provider}: ${errDetail(err)}`,
      });
    }
    throw err;
  }
}

async function keyringDelete(provider: string): Promise<void> {
  try {
    await invoke("keyring_delete", { provider });
  } catch (err) {
    // Deletion failure shouldn't block the higher-level operation (e.g.
    // removing a provider config) — the keychain entry is tidied up on
    // the next write anyway. Toast as warn, not error, because the UI
    // state moves on regardless.
    console.warn("[keyring] delete failed", err);
    pushToast({
      kind: "warn",
      message: "Couldn't remove API key from OS keychain",
      detail: `${provider}: ${errDetail(err)}`,
    });
  }
}

const DB_URL = "sqlite:founder.db";

let dbPromise: Promise<Database> | null = null;

/** Lazily open (and memoize) the DB connection. */
function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load(DB_URL);
  }
  return dbPromise;
}

// ──────────────────────────────────────────────
// Row shape (snake_case — matches the schema)
// ──────────────────────────────────────────────
type VentureRow = {
  id: string;
  name: string;
  slug: string;
  stage: string;
  root_path: string;
  created_at: string;
  updated_at: string;
  // Added in migration 0003. NULL means "fall back to global active_provider".
  default_provider: string | null;
};

function rowToVenture(r: VentureRow): Venture {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    stage: r.stage as VentureStage,
    rootPath: r.root_path,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Read the per-venture LLM provider override.
 * Returns null if the venture has no row or no override set — caller should
 * fall back to the global `app_settings.active_provider`.
 */
export async function getVentureProvider(ventureId: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ default_provider: string | null }[]>(
    "SELECT default_provider FROM ventures WHERE id = $1",
    [ventureId]
  );
  return rows[0]?.default_provider ?? null;
}

/**
 * Set (or clear, via `null`) the per-venture provider override.
 * Passing `null` causes chat calls for this venture to fall back to the
 * global active_provider again.
 */
export async function setVentureProvider(
  ventureId: string,
  provider: string | null
): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE ventures SET default_provider = $1, updated_at = $2 WHERE id = $3", [
    provider,
    new Date().toISOString(),
    ventureId,
  ]);
}

// ──────────────────────────────────────────────
// Venture queries
// ──────────────────────────────────────────────

export async function listVentures(): Promise<Venture[]> {
  const db = await getDb();
  const rows = await db.select<VentureRow[]>(
    "SELECT id, name, slug, stage, root_path, created_at, updated_at, default_provider FROM ventures ORDER BY created_at ASC"
  );
  return rows.map(rowToVenture);
}

export async function insertVenture(v: Venture): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO ventures (id, name, slug, stage, root_path, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [v.id, v.name, v.slug, v.stage, v.rootPath, v.createdAt, v.updatedAt]
  );
}

export async function updateVentureStage(id: string, stage: VentureStage): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE ventures SET stage = $1, updated_at = $2 WHERE id = $3", [
    stage,
    new Date().toISOString(),
    id,
  ]);
}

/**
 * Delete a venture and everything that references it.
 *
 * The schema declares FKs but we don't rely on SQLite's FK enforcement
 * (it's off by default in tauri-plugin-sql and toggling it via PRAGMA
 * across connections is fragile). Instead we cascade explicitly: child
 * tables first, parent last. Runs before findings because findings
 * reference runs.
 */
export async function deleteVenture(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM chat_messages WHERE venture_id = $1", [id]);
  await db.execute("DELETE FROM tasks WHERE venture_id = $1", [id]);
  await db.execute("DELETE FROM artifacts WHERE venture_id = $1", [id]);
  await db.execute(
    `DELETE FROM audit_findings
     WHERE run_id IN (SELECT run_id FROM runs WHERE venture_id = $1)`,
    [id]
  );
  await db.execute("DELETE FROM runs WHERE venture_id = $1", [id]);
  await db.execute("DELETE FROM ventures WHERE id = $1", [id]);
}

// ──────────────────────────────────────────────
// Chat message queries
//
// thread_id convention: `${ventureId}:${stage}` so each stage inside a
// venture gets its own conversation history. Change this if you'd rather
// have a single rolling thread per venture.
// ──────────────────────────────────────────────

type ChatMessageRow = {
  id: string;
  venture_id: string;
  thread_id: string;
  role: string;
  content: string;
  created_at: string;
  /** Post-0006. Null on legacy rows and user messages. */
  provider: string | null;
  /** Post-0006. "api_key" | "subscription" | null. */
  provider_mode: string | null;
};

function rowToChatMessage(r: ChatMessageRow): ChatMessage {
  return {
    id: r.id,
    role: r.role as ChatMessage["role"],
    content: r.content,
    createdAt: r.created_at,
    provider: r.provider,
    providerMode: r.provider_mode,
  };
}

export function chatThreadId(ventureId: string, stage: VentureStage): string {
  return `${ventureId}:${stage}`;
}

export async function listChatMessages(
  ventureId: string,
  stage: VentureStage
): Promise<ChatMessage[]> {
  const db = await getDb();
  const rows = await db.select<ChatMessageRow[]>(
    `SELECT id, venture_id, thread_id, role, content, created_at,
            provider, provider_mode
     FROM chat_messages
     WHERE thread_id = $1
     ORDER BY created_at ASC`,
    [chatThreadId(ventureId, stage)]
  );
  return rows.map(rowToChatMessage);
}

export async function insertChatMessage(
  ventureId: string,
  stage: VentureStage,
  msg: ChatMessage
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO chat_messages
       (id, venture_id, thread_id, role, content, created_at,
        provider, provider_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      msg.id,
      ventureId,
      chatThreadId(ventureId, stage),
      msg.role,
      msg.content,
      msg.createdAt,
      // Only assistant messages carry a provider; user/system turns
      // persist as NULL so the chat UI cleanly skips their caption.
      msg.role === "assistant" ? (msg.provider ?? null) : null,
      msg.role === "assistant" ? (msg.providerMode ?? null) : null,
    ]
  );
}

export async function clearChatThread(ventureId: string, stage: VentureStage): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM chat_messages WHERE thread_id = $1", [
    chatThreadId(ventureId, stage),
  ]);
}

// ──────────────────────────────────────────────
// Pipeline run queries
//
// A "run" row is created the moment a pipeline starts (status: "running")
// and updated to a terminal status when it finishes. Terminal values:
//   "succeeded"  — every step completed without error
//   "failed"     — a step threw or the orchestrator returned !success
//   "cancelled"  — pt.30b, the user hit Stop. Distinct from "failed" so
//                  the runs UI can render a benign neutral pill rather
//                  than failure red — a user-initiated abort isn't a fault.
// The plan itself (per-step progress) lives in component state during
// the run; only the terminal summary lands in DB so historical runs
// are inspectable later.
// ──────────────────────────────────────────────

export type RunRow = {
  runId: string;
  ventureId: string;
  type: string;
  status: string;
  summary?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
};

type RunRowDb = {
  run_id: string;
  venture_id: string;
  type: string;
  status: string;
  summary: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
};

function rowToRun(r: RunRowDb): RunRow {
  return {
    runId: r.run_id,
    ventureId: r.venture_id,
    type: r.type,
    status: r.status,
    summary: r.summary ?? undefined,
    error: r.error ?? undefined,
    createdAt: r.created_at,
    completedAt: r.completed_at ?? undefined,
  };
}

export async function insertRun(input: {
  runId: string;
  ventureId: string;
  type: string;
}): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO runs (run_id, venture_id, type, status, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.runId, input.ventureId, input.type, "running", new Date().toISOString()]
  );
}

export async function updateRunStatus(
  runId: string,
  status: string,
  opts: { summary?: string; error?: string } = {}
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE runs
     SET status = $1, summary = $2, error = $3, completed_at = $4
     WHERE run_id = $5`,
    [status, opts.summary ?? null, opts.error ?? null, new Date().toISOString(), runId]
  );
}

export async function listRunsForVenture(ventureId: string): Promise<RunRow[]> {
  const db = await getDb();
  const rows = await db.select<RunRowDb[]>(
    `SELECT run_id, venture_id, type, status, summary, error, created_at, completed_at
     FROM runs
     WHERE venture_id = $1
     ORDER BY created_at DESC`,
    [ventureId]
  );
  return rows.map(rowToRun);
}

// ──────────────────────────────────────────────
// Audit findings
//
// A finding belongs to a run (FK on run_id). Each pipeline run's audit step
// produces zero or more findings; we insert them in a single batch after the
// run completes. `id` is synthesized as `${runId}-${index}` for stable
// uniqueness without a UUID round-trip.
//
// `severity` maps directly to the audit-contract enum: low / medium / high /
// critical. Callers rendering UI should group by severity descending.
// ──────────────────────────────────────────────

export type FindingRow = {
  id: string;
  runId: string;
  ventureId: string;
  ruleId: string;
  severity: "low" | "medium" | "high" | "critical";
  title: string;
  message: string;
  filePath?: string;
  createdAt: string;
};

type FindingRowDb = {
  id: string;
  run_id: string;
  venture_id: string;
  rule_id: string;
  severity: string;
  title: string;
  message: string;
  file_path: string | null;
  created_at: string;
};

function rowToFinding(r: FindingRowDb): FindingRow {
  return {
    id: r.id,
    runId: r.run_id,
    ventureId: r.venture_id,
    ruleId: r.rule_id,
    severity: r.severity as FindingRow["severity"],
    title: r.title,
    message: r.message,
    filePath: r.file_path ?? undefined,
    createdAt: r.created_at,
  };
}

/**
 * Insert a batch of findings for one run. Uses `INSERT OR REPLACE` keyed on
 * `id` so a re-run of the audit step for the same runId rewrites cleanly
 * rather than accumulating duplicates.
 */
export async function insertAuditFindings(input: {
  runId: string;
  ventureId: string;
  findings: Array<{
    ruleId: string;
    severity: "low" | "medium" | "high" | "critical";
    title: string;
    message: string;
    filePath?: string;
  }>;
}): Promise<void> {
  if (input.findings.length === 0) return;
  const db = await getDb();
  const now = new Date().toISOString();
  // One row at a time — tauri-plugin-sql doesn't expose a batch-insert API
  // and the volumes here are tiny (usually < 20 per run).
  for (let i = 0; i < input.findings.length; i++) {
    const f = input.findings[i];
    await db.execute(
      `INSERT OR REPLACE INTO audit_findings
       (id, run_id, venture_id, rule_id, severity, title, message, file_path, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        `${input.runId}-${i}`,
        input.runId,
        input.ventureId,
        f.ruleId,
        f.severity,
        f.title,
        f.message,
        f.filePath ?? null,
        now,
      ]
    );
  }
}

export async function listFindingsForRun(runId: string): Promise<FindingRow[]> {
  const db = await getDb();
  const rows = await db.select<FindingRowDb[]>(
    `SELECT id, run_id, venture_id, rule_id, severity, title, message, file_path, created_at
     FROM audit_findings
     WHERE run_id = $1
     ORDER BY CASE severity
       WHEN 'critical' THEN 0
       WHEN 'high'     THEN 1
       WHEN 'medium'   THEN 2
       WHEN 'low'      THEN 3
       ELSE 4
     END, created_at ASC`,
    [runId]
  );
  return rows.map(rowToFinding);
}

export async function listFindingsForVenture(ventureId: string): Promise<FindingRow[]> {
  const db = await getDb();
  const rows = await db.select<FindingRowDb[]>(
    `SELECT id, run_id, venture_id, rule_id, severity, title, message, file_path, created_at
     FROM audit_findings
     WHERE venture_id = $1
     ORDER BY created_at DESC`,
    [ventureId]
  );
  return rows.map(rowToFinding);
}

// ──────────────────────────────────────────────
// Audit fix-suggestion cache
//
// AI-generated fix text keyed per finding. We persist the full final
// response (not streaming chunks) so a user re-opening a run doesn't
// re-burn tokens on the same diagnosis.
// ──────────────────────────────────────────────

export type FixSuggestionRow = {
  findingId: string;
  text: string;
  provider: string;
  model: string | null;
  createdAt: string;
};

type FixSuggestionRowDb = {
  finding_id: string;
  text: string;
  provider: string;
  model: string | null;
  created_at: string;
};

function rowToFixSuggestion(r: FixSuggestionRowDb): FixSuggestionRow {
  return {
    findingId: r.finding_id,
    text: r.text,
    provider: r.provider,
    model: r.model,
    createdAt: r.created_at,
  };
}

export async function upsertFixSuggestion(input: {
  findingId: string;
  text: string;
  provider: string;
  model?: string | null;
}): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  // INSERT OR REPLACE is keyed on finding_id (PK), so "Ask again"
  // overwrites the previous suggestion in place.
  await db.execute(
    `INSERT OR REPLACE INTO audit_fix_suggestions
       (finding_id, text, provider, model, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.findingId, input.text, input.provider, input.model ?? null, now]
  );
}

/**
 * Return every persisted fix suggestion for findings in a run, keyed by
 * finding id. Callers use the map to seed UI state so the drawer
 * re-appears on a second visit without another LLM call.
 */
export async function listFixSuggestionsForRun(
  runId: string
): Promise<Record<string, FixSuggestionRow>> {
  const db = await getDb();
  const rows = await db.select<FixSuggestionRowDb[]>(
    `SELECT s.finding_id, s.text, s.provider, s.model, s.created_at
     FROM audit_fix_suggestions s
     JOIN audit_findings f ON f.id = s.finding_id
     WHERE f.run_id = $1`,
    [runId]
  );
  const out: Record<string, FixSuggestionRow> = {};
  for (const r of rows) out[r.finding_id] = rowToFixSuggestion(r);
  return out;
}

export async function deleteFixSuggestion(findingId: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM audit_fix_suggestions WHERE finding_id = $1", [findingId]);
}

// ──────────────────────────────────────────────
// Artifact queries
//
// The scanner walks disk and writes one row per file it finds. We use
// INSERT OR REPLACE keyed on artifact_id (which is derived from
// venture+type+relativePath, see artifacts-core/computeArtifactId) so a
// re-scan after a pipeline run upserts cleanly without duplicates.
//
// NOTE: the schema column is `artifact_id`, not `id` — the older
// `artifacts-index/sync.ts` writes to `id` and would fail at runtime.
// We don't use that path; this is the desktop-side replacement.
// ──────────────────────────────────────────────

export type ArtifactRow = {
  artifactId: string;
  ventureId: string;
  type: string;
  path: string;
  hash?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

type ArtifactRowDb = {
  artifact_id: string;
  venture_id: string;
  type: string;
  path: string;
  hash: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

function rowToArtifact(r: ArtifactRowDb): ArtifactRow {
  return {
    artifactId: r.artifact_id,
    ventureId: r.venture_id,
    type: r.type,
    path: r.path,
    hash: r.hash ?? undefined,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function upsertArtifact(input: {
  artifactId: string;
  ventureId: string;
  type: string;
  path: string;
  hash?: string;
  status?: string;
}): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  // INSERT OR REPLACE rewrites created_at on conflict — that's fine for
  // MVP. If we want true "first-seen" timestamps later, swap to an
  // UPSERT that COALESCEs created_at from the existing row.
  await db.execute(
    `INSERT OR REPLACE INTO artifacts
     (artifact_id, venture_id, type, path, hash, status, created_at, updated_at, derived_from_json, tags_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '[]', '[]')`,
    [
      input.artifactId,
      input.ventureId,
      input.type,
      input.path,
      input.hash ?? null,
      input.status ?? "ready",
      now,
      now,
    ]
  );
}

export async function listArtifactsForVenture(ventureId: string): Promise<ArtifactRow[]> {
  const db = await getDb();
  const rows = await db.select<ArtifactRowDb[]>(
    `SELECT artifact_id, venture_id, type, path, hash, status, created_at, updated_at
     FROM artifacts
     WHERE venture_id = $1
     ORDER BY updated_at DESC`,
    [ventureId]
  );
  return rows.map(rowToArtifact);
}

/** Wipe all artifact rows for a venture. Useful before a fresh re-scan when
 *  files have been removed on disk (INSERT OR REPLACE only handles changes,
 *  not deletions). */
export async function clearArtifactsForVenture(ventureId: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM artifacts WHERE venture_id = $1", [ventureId]);
}

// ──────────────────────────────────────────────
// LLM provider settings
//
// One row per provider (anthropic / openai / …). Keys are global — there's
// no venture_id column; the premise is a single user pasting their API keys
// once. `enabled` is 0/1 because SQLite has no bool type. When the user
// clicks "Save" on a provider row we upsert that provider only.
// ──────────────────────────────────────────────

/**
 * How Founder OS talks to a provider.
 *
 * - `api_key`      → hit the provider's HTTP API with a saved key (the
 *                    pre-0005 default, applied to legacy rows via the
 *                    column's DEFAULT).
 * - `subscription` → shell out to the vendor's own CLI (`claude`, `codex`,
 *                    `gemini`), which authenticates against the user's
 *                    consumer subscription and handles its own credentials
 *                    on disk. No API key is required or stored.
 *
 * Only anthropic / openai / gemini have subscription CLIs today; see
 * `cli_agent.rs` for the canonical mapping. Setting `mode: 'subscription'`
 * on any other provider would pass validation here but `cli_agent_stream`
 * would reject the call at send time.
 */
export type LlmMode = "api_key" | "subscription";

export type LlmSetting = {
  provider: string;
  apiKey: string | null;
  baseUrl: string | null;
  model: string;
  enabled: boolean;
  /** See {@link LlmMode}. Always a concrete value — legacy rows migrate
   *  to `'api_key'` via the column's DEFAULT. */
  mode: LlmMode;
  updatedAt: string;
};

type LlmSettingRow = {
  provider: string;
  api_key: string | null;
  base_url: string | null;
  model: string;
  enabled: number;
  mode: string | null;
  updated_at: string;
};

function rowToLlmSetting(r: LlmSettingRow): LlmSetting {
  return {
    provider: r.provider,
    apiKey: r.api_key,
    baseUrl: r.base_url,
    model: r.model,
    enabled: r.enabled === 1,
    // Defensive: a NULL slip-through from any caller that INSERTs without
    // specifying mode (should be impossible after 0005 since the column
    // is NOT NULL DEFAULT 'api_key', but costs nothing to guard).
    mode: r.mode === "subscription" ? "subscription" : "api_key",
    updatedAt: r.updated_at,
  };
}

// ──────────────────────────────────────────────
// Keychain migration tripwire (pt.23)
//
// Keys have lived in the OS keychain since pt.22, with a lazy
// plaintext→keychain migration path inside `resolveApiKey` for legacy
// rows. This flag records that the migration has fully completed at
// least once (boot-time drain observed zero plaintext rows OR moved
// every remaining row into the keychain). Once set:
//   - `resolveApiKey` stops reading `api_key` entirely — keychain-only.
//   - The plaintext fallback branch becomes unreachable code, safe to
//     remove in a later cleanup (leaving the nullable column in place is
//     fine; SQLite column-drop is fussy pre-3.35 and buys us nothing).
//
// Stored in the generic `app_settings` table — no DDL migration needed.
// Value is literal "1" when set; anything else (absent, "", "0") counts
// as unmigrated so we stay conservative.
// ──────────────────────────────────────────────

export const KEYCHAIN_MIGRATED_KEY = "keychain_migrated";

// In-memory mirror so the `resolveApiKey` hot path doesn't hit SQLite on
// every call. First read fills the cache; `markKeychainMigrated()` and
// `drainPlaintextKeysToKeychain()` update it in place so callers see a
// fresh value without a re-query.
let keychainMigratedCache: boolean | null = null;

// In-flight promise so concurrent first-reads (e.g. `listLlmSettings`
// resolving N rows in parallel) collapse onto one SQLite query instead
// of N. Cleared once it resolves — subsequent reads hit the cache.
let keychainMigratedPromise: Promise<boolean> | null = null;

export async function isKeychainMigrated(): Promise<boolean> {
  if (keychainMigratedCache !== null) return keychainMigratedCache;
  if (!keychainMigratedPromise) {
    keychainMigratedPromise = (async () => {
      try {
        const value = await getAppSetting(KEYCHAIN_MIGRATED_KEY);
        const migrated = value === "1";
        keychainMigratedCache = migrated;
        return migrated;
      } finally {
        keychainMigratedPromise = null;
      }
    })();
  }
  return keychainMigratedPromise;
}

async function markKeychainMigrated(): Promise<void> {
  await setAppSetting(KEYCHAIN_MIGRATED_KEY, "1");
  keychainMigratedCache = true;
}

/**
 * One-shot boot-time drain. Idempotent:
 *   - Flag already set → no-op, returns `alreadyMigrated: true`.
 *   - No plaintext rows (fresh install OR lazy-migrated by resolveApiKey
 *     in a previous session) → stamp the flag, return `scanned: 0`.
 *   - Some plaintext rows → keyringSet + null the column per row. If
 *     every row succeeded, stamp the flag. A partial failure keeps the
 *     flag unset so next boot retries (and `resolveApiKey` stays in its
 *     legacy-fallback mode in the meantime).
 *
 * Returns a stats bundle so the caller (App.tsx hydrate) can decide
 * whether to toast anything — silent on the common no-op paths.
 */
export async function drainPlaintextKeysToKeychain(): Promise<{
  alreadyMigrated: boolean;
  scanned: number;
  moved: number;
  failed: number;
}> {
  if (await isKeychainMigrated()) {
    return { alreadyMigrated: true, scanned: 0, moved: 0, failed: 0 };
  }
  const db = await getDb();
  const rows = await db.select<LlmSettingRow[]>(
    "SELECT provider, api_key, base_url, model, enabled, mode, updated_at FROM llm_settings WHERE api_key IS NOT NULL AND api_key != ''"
  );
  if (rows.length === 0) {
    // Either a fresh install or all plaintext rows already drained via
    // lazy `resolveApiKey` migration in a prior session. Stamp the flag
    // so the fallback code path becomes dead in future sessions.
    await markKeychainMigrated();
    return { alreadyMigrated: false, scanned: 0, moved: 0, failed: 0 };
  }
  let moved = 0;
  let failed = 0;
  for (const row of rows) {
    if (!row.api_key) continue; // defensive — SQL already filtered
    try {
      // silent: true — the caller's toast is worded for the whole drain
      // (e.g. "Moved 3 API key(s) into OS keychain"); per-provider save
      // toasts would misrepresent this as user-initiated.
      await keyringSet(row.provider, row.api_key, { silent: true });
      await db.execute("UPDATE llm_settings SET api_key = NULL WHERE provider = $1", [
        row.provider,
      ]);
      moved += 1;
    } catch (err) {
      console.warn("[keyring] drain deferred for", row.provider, err);
      failed += 1;
    }
  }
  if (failed === 0) {
    await markKeychainMigrated();
  }
  return { alreadyMigrated: false, scanned: rows.length, moved, failed };
}

/**
 * Resolve the real API key for a row, preferring the OS keychain.
 *
 * Two modes based on the `keychain_migrated` flag (see
 * `drainPlaintextKeysToKeychain` above):
 *
 *  - **Migrated install** (flag set): keychain-only. The `api_key` column
 *    is considered dead. A keychain miss returns `null` — the caller
 *    treats that as "not configured" (or "keychain unavailable", which
 *    already surfaced its own toast via `keyringGet`).
 *
 *  - **Legacy install** (flag unset): keychain-first, with a lazy
 *    plaintext→keychain migration on fallback. This is the pre-pt.23
 *    behaviour, preserved here for one or two more boots so any
 *    install that somehow missed the boot-time drain still self-heals.
 *    Once the boot-time drain succeeds, this branch becomes unreachable.
 *
 * Side effect (migrated mode): if a stray plaintext column value is
 * observed alongside a keychain value, we null the column so we don't
 * leave secrets sitting on disk past their "dead code" designation.
 */
async function resolveApiKey(row: LlmSettingRow): Promise<string | null> {
  const fromKeyring = await keyringGet(row.provider);
  const migrated = await isKeychainMigrated();
  if (fromKeyring) {
    // If we still have a plaintext row hanging around (upgraded install,
    // partial migration, etc.), scrub it now — authoritative value is in
    // the keychain.
    if (row.api_key) {
      const db = await getDb();
      await db.execute("UPDATE llm_settings SET api_key = NULL WHERE provider = $1", [
        row.provider,
      ]);
    }
    return fromKeyring;
  }
  if (migrated) {
    // Plaintext column is dead once the flag is stamped. A keychain miss
    // here means "not configured" — don't revive the fallback path.
    return null;
  }
  if (row.api_key) {
    // Legacy auto-migration path. `silent: true` stops keyringSet from
    // pushing its error toast — that toast is worded for user-initiated
    // saves and would be misleading here (the user didn't ask us to do
    // anything). We toast our own, more honest warn below so the user
    // still knows the keychain is degraded.
    try {
      await keyringSet(row.provider, row.api_key, { silent: true });
      const db = await getDb();
      await db.execute("UPDATE llm_settings SET api_key = NULL WHERE provider = $1", [
        row.provider,
      ]);
    } catch (err) {
      // Keychain unavailable — keep serving the plaintext value so the
      // user's chat doesn't suddenly break. Migration will retry next
      // time. Toast dedupe collapses the per-provider spam into one row.
      console.warn("[keyring] migration deferred", err);
      pushToast({
        kind: "warn",
        message: "OS keychain unavailable — still using saved keys from SQLite",
        detail:
          "Your API keys will keep working, but they remain in plaintext on disk. Check your OS credential store.",
      });
    }
    return row.api_key;
  }
  return null;
}

export async function listLlmSettings(): Promise<LlmSetting[]> {
  const db = await getDb();
  const rows = await db.select<LlmSettingRow[]>(
    "SELECT provider, api_key, base_url, model, enabled, mode, updated_at FROM llm_settings"
  );
  // Resolve keys in parallel — each row is an independent keychain hit.
  const settings = await Promise.all(
    rows.map(async (r) => {
      const apiKey = await resolveApiKey(r);
      return { ...rowToLlmSetting(r), apiKey };
    })
  );
  return settings;
}

export async function getLlmSetting(provider: string): Promise<LlmSetting | null> {
  const db = await getDb();
  const rows = await db.select<LlmSettingRow[]>(
    "SELECT provider, api_key, base_url, model, enabled, mode, updated_at FROM llm_settings WHERE provider = $1",
    [provider]
  );
  const first = rows[0];
  if (!first) return null;
  const apiKey = await resolveApiKey(first);
  return { ...rowToLlmSetting(first), apiKey };
}

/**
 * Upsert one provider's settings. We intentionally accept a partial shape so
 * the caller can, e.g., toggle `enabled` without re-pasting the API key —
 * missing fields are kept as-is via COALESCE on the existing row.
 */
export async function upsertLlmSetting(input: {
  provider: string;
  apiKey?: string | null;
  baseUrl?: string | null;
  model?: string;
  enabled?: boolean;
  /** See {@link LlmMode}. Omit to leave untouched on an existing row;
   *  defaults to `'api_key'` on first insert via the column default. */
  mode?: LlmMode;
}): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();

  // API keys don't go into SQLite anymore — they live in the OS keychain.
  // `apiKey === undefined`  → leave whatever's in the keychain untouched
  // `apiKey === null`       → explicitly clear (user hit "Remove key")
  // `apiKey === "..."`      → replace
  //
  // Flipping a provider to subscription mode doesn't auto-delete its
  // keychain entry — the user may want to flip back without re-pasting.
  // Delete only on an explicit null/empty apiKey (the Remove button) or
  // via `deleteLlmSetting`.
  if (input.apiKey !== undefined) {
    if (input.apiKey === null || input.apiKey === "") {
      await keyringDelete(input.provider);
    } else {
      await keyringSet(input.provider, input.apiKey);
    }
  }

  // `model` is NOT NULL in the schema. Two placeholders so we can
  // satisfy the NOT NULL constraint on INSERT *and* preserve the
  // existing model on UPDATE when the caller passed nothing:
  //   $3 = the raw input.model (or null) — used for the UPDATE COALESCE
  //        so `undefined` preserves the existing row.
  //   $4 = input.model OR the catalog default — used for INSERT so a
  //        brand-new row (e.g. subscription-mode flip) gets a valid
  //        non-null value without the caller having to know the model.
  const catalogFallback = input.model ?? defaultModelFor(input.provider);

  // Always null the legacy plaintext column when we touch a row so we
  // don't leave dangling secrets behind even if a caller smuggles one in.
  await db.execute(
    `INSERT INTO llm_settings (provider, api_key, base_url, model, enabled, mode, updated_at)
     VALUES ($1, NULL, $2, COALESCE($3, $4), $5, COALESCE($6, 'api_key'), $7)
     ON CONFLICT(provider) DO UPDATE SET
       api_key    = NULL,
       base_url   = COALESCE(excluded.base_url,   llm_settings.base_url),
       model      = COALESCE($3,                  llm_settings.model),
       enabled    = COALESCE(excluded.enabled,    llm_settings.enabled),
       mode       = COALESCE($6,                  llm_settings.mode),
       updated_at = excluded.updated_at`,
    [
      input.provider,
      input.baseUrl ?? null,
      input.model ?? null,
      catalogFallback,
      input.enabled === undefined ? null : input.enabled ? 1 : 0,
      input.mode ?? null,
      now,
    ]
  );
}

export async function deleteLlmSetting(provider: string): Promise<void> {
  const db = await getDb();
  // Remove the keychain entry too — otherwise a later re-add of the same
  // provider would silently resurrect the old key, which is confusing.
  await keyringDelete(provider);
  await db.execute("DELETE FROM llm_settings WHERE provider = $1", [provider]);
}

// ──────────────────────────────────────────────
// Generic app_settings key/value store
//
// Used for app-wide prefs that don't need a dedicated table — currently just
// `active_provider`, but we'll likely add theme, telemetry opt-in, etc.
// ──────────────────────────────────────────────

export async function getAppSetting(key: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>(
    "SELECT value FROM app_settings WHERE key = $1",
    [key]
  );
  return rows[0]?.value ?? null;
}

export async function setAppSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
    [key, value, new Date().toISOString()]
  );
}

/**
 * Remove an app-wide setting entirely. Distinct from `setAppSetting(key, "")` —
 * a deleted row means "no preference, use defaults", whereas an empty string
 * means "explicitly empty", which can be a valid value for some keys.
 */
export async function deleteAppSetting(key: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM app_settings WHERE key = $1", [key]);
}

export const ACTIVE_PROVIDER_KEY = "active_provider";

// ──────────────────────────────────────────────
// Editor preference (Options ▸ Editor card)
//
// Stored in `app_settings` under `editor_command`. Three states:
//   - row absent → auto-detect (try the built-in candidate chain in Rust)
//   - row present, single token (e.g. "code", "cursor", absolute path) → run
//     it with the file path as the only argument
//   - row present, contains `{path}` → treat as a shell command template;
//     Rust shell-evaluates after substituting the placeholder
// ──────────────────────────────────────────────

export const EDITOR_COMMAND_KEY = "editor_command";

/** Returns the user's preferred editor command, or null for auto-detect. */
export async function getEditorCommand(): Promise<string | null> {
  const value = await getAppSetting(EDITOR_COMMAND_KEY);
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Set the editor preference. Pass `null` (or empty string) to clear back to
 * auto-detect — the row gets deleted rather than set to "" so the absent vs
 * empty distinction stays clean.
 */
export async function setEditorCommand(value: string | null): Promise<void> {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) {
    await deleteAppSetting(EDITOR_COMMAND_KEY);
    return;
  }
  await setAppSetting(EDITOR_COMMAND_KEY, trimmed);
}
