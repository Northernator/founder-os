/**
 * Bridge to the persistent brand-name triage commands in
 * src-tauri/src/brand_names.rs.
 *
 * The Brand tab persists every generated name candidate to SQLite so
 * the user can triage names ('possible' / 'fail') across multiple
 * regeneration runs without losing context. This module exposes the
 * three Tauri commands as typed async functions plus the shared row
 * type — the UI layer talks to this file, never to `invoke` directly.
 *
 * Errors from `invoke` are surfaced via `pushToast` and re-thrown so
 * callers can react (e.g. skip the post-mutation refresh on failure).
 * Don't swallow errors silently here — a silent triage that didn't
 * persist would mislead the user into thinking their decision was
 * captured.
 */

import { invoke } from "@tauri-apps/api/core";

import { pushToast } from "./toasts.js";

/**
 * Triage status for a stored candidate. Mirrors the CHECK-style guard
 * in `brand_name_set_status` — keep these in sync if the Rust list
 * changes.
 */
export type BrandNameStatus = "new" | "possible" | "fail";

/**
 * Whatever brand-gen serialised into `info_json`. Today this is the
 * full `NamingCandidate` shape (rationale, style, domainStatus, …) but
 * we treat it as opaque here — the renderer parses defensively per
 * field rather than trusting a schema, because partial payloads are
 * possible (e.g. generation aborted mid-write).
 */
export type BrandNameInfo = Record<string, unknown>;

/**
 * One row from `brand_name_list`. Matches the `BrandNameRow` struct in
 * `brand_names.rs` after camelCase serialisation.
 */
export interface BrandNameCandidate {
  /** Candidate name. Unique per venture. */
  name: string;
  /** Parsed `info_json`. May be missing fields; render defensively. */
  info: BrandNameInfo;
  status: BrandNameStatus;
  /** ISO-8601 UTC. When the row was first inserted. */
  createdAt: string;
  /** ISO-8601 UTC. Set once the user moves the row out of 'new'. */
  decidedAt?: string;
}

/**
 * Raw shape returned by `brand_name_list`. We re-parse `info_json`
 * before handing it to the UI so consumers don't have to repeat the
 * JSON.parse + try/catch dance.
 */
interface BrandNameRowRaw {
  name: string;
  infoJson: string;
  status: string;
  createdAt: string;
  decidedAt: string | null;
}

function errDetail(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return JSON.stringify(err);
}

/**
 * Persist a generated candidate. Idempotent — calling with the same
 * (ventureId, name) is a no-op on the Rust side, so the existing
 * status survives a regeneration that re-suggests an already-known
 * name. `info` is JSON-stringified once here to keep the wire format
 * identical to what we'll read back later.
 */
export async function brandNameUpsert(opts: {
  ventureId: string;
  name: string;
  info: BrandNameInfo;
}): Promise<void> {
  try {
    await invoke("brand_name_upsert", {
      ventureId: opts.ventureId,
      name: opts.name,
      infoJson: JSON.stringify(opts.info),
    });
  } catch (err) {
    pushToast({
      kind: "error",
      message: `Couldn't save candidate "${opts.name}"`,
      detail: errDetail(err),
    });
    throw err;
  }
}

/**
 * Rewrite the `info_json` payload for an existing row. Used after
 * availability checks (domain / trademark / socials) populate fields
 * inside the payload — the triage status and decided_at are kept
 * intact by the Rust handler, so the founder's decision survives a
 * research refresh.
 *
 * Caller is responsible for passing the FULL merged payload; the Rust
 * handler does a string overwrite, not a JSON merge. The merge happens
 * here in TS where we already have the typed shape.
 */
export async function brandNameUpdateInfo(opts: {
  ventureId: string;
  name: string;
  info: BrandNameInfo;
}): Promise<void> {
  try {
    await invoke("brand_name_update_info", {
      ventureId: opts.ventureId,
      name: opts.name,
      infoJson: JSON.stringify(opts.info),
    });
  } catch (err) {
    pushToast({
      kind: "error",
      message: `Couldn't save check results for "${opts.name}"`,
      detail: errDetail(err),
    });
    throw err;
  }
}

/**
 * Move a candidate to `possible` / `fail` / back to `new`. The Rust
 * side stamps `decided_at` for terminal states and clears it on
 * 'new' — callers don't need to manage that timestamp themselves.
 */
export async function brandNameSetStatus(opts: {
  ventureId: string;
  name: string;
  status: BrandNameStatus;
}): Promise<void> {
  try {
    await invoke("brand_name_set_status", {
      ventureId: opts.ventureId,
      name: opts.name,
      status: opts.status,
    });
  } catch (err) {
    pushToast({
      kind: "error",
      message: `Couldn't update "${opts.name}" status`,
      detail: errDetail(err),
    });
    throw err;
  }
}

/**
 * Read every candidate for a venture. Returns the rows in their
 * server-side ordering (POSSIBLE → NEW → FAIL, by most recent
 * activity) so the renderer can iterate without re-sorting.
 *
 * `info_json` is parsed defensively — if it's malformed (shouldn't
 * happen, but storage may pre-date a schema change) the row is kept
 * with `info = {}` rather than dropped, so the user can still see
 * the name and triage it.
 */
export async function brandNameList(ventureId: string): Promise<BrandNameCandidate[]> {
  try {
    const raw = await invoke<BrandNameRowRaw[]>("brand_name_list", { ventureId });
    return raw.map((row) => {
      let info: BrandNameInfo = {};
      try {
        const parsed = JSON.parse(row.infoJson);
        if (parsed && typeof parsed === "object") info = parsed as BrandNameInfo;
      } catch {
        // Keep the row visible with an empty info — better to triage
        // a name with missing detail than to silently drop it.
      }
      const candidate: BrandNameCandidate = {
        name: row.name,
        info,
        status: normaliseStatus(row.status),
        createdAt: row.createdAt,
      };
      if (row.decidedAt) candidate.decidedAt = row.decidedAt;
      return candidate;
    });
  } catch (err) {
    pushToast({
      kind: "error",
      message: "Couldn't load name candidates",
      detail: errDetail(err),
    });
    throw err;
  }
}

/**
 * Defensive coercion: the column is constrained to one of three values
 * by the upsert/set commands, but a future migration or hand-edit
 * could leave a stray. Anything unrecognised falls back to 'new' so
 * the user sees the row and can re-triage.
 */
function normaliseStatus(value: string): BrandNameStatus {
  if (value === "possible" || value === "fail" || value === "new") return value;
  return "new";
}
