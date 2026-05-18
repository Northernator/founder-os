/**
 * Supabase HTTP client primitives for the BackendProvider.
 *
 * Same shape as src/http.ts (the PocketBase wrapper). All network IO
 * goes through an injectable `fetchImpl` so tests never touch the wire;
 * the default is `globalThis.fetch.bind(globalThis)` to dodge the
 * "Illegal invocation" trap documented in
 * feedback_browser_fetch_illegal_invocation.
 *
 * Three surface areas:
 *
 *   - healthProbe()         GET <projectUrl>/auth/v1/health
 *                           Used by provision() to validate the URL +
 *                           pull the gotrue version into BackendInstance.
 *
 *   - checkExecSqlExists()  Probes whether the `public.exec_sql`
 *                           helper function has been installed in the
 *                           founder's Supabase project (see
 *                           SUPABASE-MODULE-SPEC.md sec 8). Used by
 *                           applySchema() before issuing DDL.
 *
 *   - execSql()             POST <projectUrl>/rest/v1/rpc/exec_sql
 *                           with `{ query: sql }`. Service-role-key
 *                           auth. Runs DDL statements.
 *
 * The provider stays Node-stdlib-free (no third-party deps beyond
 * @founder-os/backend-core) so it embeds cleanly from the desktop,
 * the cowork sidecar, or a CI job. Crucially: no node:* imports here,
 * so this file is safe to ship via the client-safe barrel.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SupabaseHttpError extends Error {
  override readonly name = "SupabaseHttpError";
  constructor(
    readonly method: string,
    readonly url: string,
    readonly status: number,
    readonly bodyText: string
  ) {
    super(`Supabase ${method} ${url} -> ${status}: ${bodyText.slice(0, 200)}`);
  }
}

export class SupabaseHealthError extends Error {
  override readonly name = "SupabaseHealthError";
  constructor(readonly projectUrl: string, override readonly cause?: unknown) {
    super(`Supabase health probe failed at ${projectUrl}`);
  }
}

export class SupabaseBadCredentialsError extends Error {
  override readonly name = "SupabaseBadCredentialsError";
  constructor(readonly status: number, readonly bodyText: string) {
    super(
      `Supabase rejected the service-role key (HTTP ${status}). ` +
        `Re-check the value pasted into the BackendTab.`
    );
  }
}

/**
 * Thrown by applySchema() when the project doesn't yet have the
 * `public.exec_sql(query text)` helper installed. The error message
 * includes the exact SQL the founder should paste into the Supabase
 * dashboard's SQL editor.
 */
export class MissingExecSqlError extends Error {
  override readonly name = "MissingExecSqlError";
  constructor(readonly bootstrapSql: string) {
    super(
      "Supabase project is missing the `public.exec_sql` helper " +
        "function. Paste the SQL in `bootstrapSql` into the Supabase " +
        "dashboard's SQL editor (once), then re-run the BACKEND stage."
    );
  }
}

// ---------------------------------------------------------------------------
// The exec_sql bootstrap SQL
// ---------------------------------------------------------------------------

/**
 * One-time SQL the founder pastes into the Supabase SQL editor to
 * enable DDL-via-REST. `security definer` lets the function execute
 * with the elevated privileges of its owner (the role that ran this
 * SQL -- typically `postgres`), and the `revoke ... grant only to
 * service_role` pair ensures only service-role JWTs can call it.
 *
 * Documented verbatim in SUPABASE-MODULE-SPEC.md sec 8. Keep the two
 * in sync.
 */
export const EXEC_SQL_BOOTSTRAP_SQL = `-- founder-os: one-time bootstrap for the BACKEND stage's applySchema().
-- Paste into the Supabase SQL editor and run once per project.
create or replace function public.exec_sql(query text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  execute query;
end;
$$;

revoke all on function public.exec_sql(text) from public, anon, authenticated;
grant execute on function public.exec_sql(text) to service_role;
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FetchLike = typeof fetch;

export type HealthProbeOpts = {
  projectUrl: string;
  fetchImpl?: FetchLike;
};

export type HealthProbeResult = {
  /**
   * Free-text version string returned by `/auth/v1/health`. Supabase
   * returns e.g. `"goTrue Version: v2.143.0"` -- we keep it verbatim
   * for the BackendInstance.resolvedVersion field rather than parsing
   * a brittle subset.
   */
  version: string;
  /**
   * Raw response body for log tail / diagnostics.
   */
  raw: string;
};

export type ExecSqlOpts = {
  projectUrl: string;
  serviceRoleKey: string;
  sql: string;
  fetchImpl?: FetchLike;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Bind to globalThis so tests injecting a bare `fetch` reference can't
 * crash with "Illegal invocation" in the webview environment. Mirrors
 * the http.ts default in the PocketBase wrapper.
 */
function defaultFetch(): FetchLike {
  if (typeof globalThis.fetch !== "function") {
    throw new Error(
      "globalThis.fetch is not available -- pass `fetchImpl` explicitly."
    );
  }
  return globalThis.fetch.bind(globalThis);
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

export async function healthProbe(
  opts: HealthProbeOpts
): Promise<HealthProbeResult> {
  const fetcher = opts.fetchImpl ?? defaultFetch();
  const url = `${trimTrailingSlash(opts.projectUrl)}/auth/v1/health`;
  let response: Response;
  try {
    response = await fetcher(url, { method: "GET" });
  } catch (err) {
    throw new SupabaseHealthError(opts.projectUrl, err);
  }
  const body = await response.text();
  if (!response.ok) {
    // Supabase's /auth/v1/health is public -- a non-2xx here means
    // the project URL is wrong / paused / deleted.
    throw new SupabaseHealthError(opts.projectUrl, body);
  }
  // The endpoint returns either plain text or a small JSON; we pass
  // the body through to the caller.
  return { version: body.trim(), raw: body };
}

/**
 * Whether `public.exec_sql` exists in the project. We call it with a
 * cheap no-op (`select 1;`); a 200 means the function is installed,
 * a 404 means it isn't, and any other error propagates as
 * SupabaseHttpError so the runner sees it.
 */
export async function checkExecSqlExists(opts: {
  projectUrl: string;
  serviceRoleKey: string;
  fetchImpl?: FetchLike;
}): Promise<boolean> {
  const fetcher = opts.fetchImpl ?? defaultFetch();
  const url = `${trimTrailingSlash(opts.projectUrl)}/rest/v1/rpc/exec_sql`;
  const response = await fetcher(url, {
    method: "POST",
    headers: {
      apikey: opts.serviceRoleKey,
      Authorization: `Bearer ${opts.serviceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query: "select 1;" }),
  });
  if (response.status === 404) return false;
  // PostgREST returns 404 when the function does not exist; some
  // Supabase deployments return 400 with a "function does not exist"
  // body instead. Treat both as "not installed".
  if (response.status === 400) {
    const body = await response.text();
    if (/exec_sql.*does not exist/i.test(body)) return false;
  }
  if (response.status === 401 || response.status === 403) {
    const body = await response.text();
    throw new SupabaseBadCredentialsError(response.status, body);
  }
  if (!response.ok) {
    const body = await response.text();
    throw new SupabaseHttpError("POST", url, response.status, body);
  }
  return true;
}

/**
 * Execute a SQL statement via `public.exec_sql`. The function returns
 * void; the only useful signal is HTTP status. SQL errors come back
 * as 400 with a Postgres error body, which we surface verbatim via
 * SupabaseHttpError.
 */
export async function execSql(opts: ExecSqlOpts): Promise<void> {
  const fetcher = opts.fetchImpl ?? defaultFetch();
  const url = `${trimTrailingSlash(opts.projectUrl)}/rest/v1/rpc/exec_sql`;
  const response = await fetcher(url, {
    method: "POST",
    headers: {
      apikey: opts.serviceRoleKey,
      Authorization: `Bearer ${opts.serviceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query: opts.sql }),
  });
  if (response.status === 401 || response.status === 403) {
    const body = await response.text();
    throw new SupabaseBadCredentialsError(response.status, body);
  }
  if (!response.ok) {
    const body = await response.text();
    throw new SupabaseHttpError("POST", url, response.status, body);
  }
  // Success -- exec_sql returns void / null; we don't need to
  // deserialize the body.
}
