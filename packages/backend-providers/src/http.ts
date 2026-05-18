/**
 * PocketBase REST client primitives for the BackendProvider's `export()`
 * step. The provider authenticates as an admin and reads the live
 * collection list + auth providers, then translates that into a
 * BackendExport.
 *
 * Network surface is small on purpose: auth + collection list + health
 * probe. Anything heavier (records CRUD, file uploads, realtime
 * subscriptions) lives on the BUILD side, against the frontend SDK that
 * gets generated in slice 4.
 *
 * fetchImpl is injectable so tests never touch the network. The default
 * is globalThis.fetch.bind(globalThis) -- Node >= 18 ships fetch on the
 * global, and the bind() guards against the "Illegal invocation" trap
 * documented in feedback_browser_fetch_illegal_invocation.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PocketbaseHttpError extends Error {
  override readonly name = "PocketbaseHttpError";
  constructor(
    readonly method: string,
    readonly url: string,
    readonly status: number,
    readonly bodyText: string
  ) {
    super(`PocketBase ${method} ${url} -> ${status}`);
  }
}

export class PocketbaseAuthError extends Error {
  override readonly name = "PocketbaseAuthError";
  constructor(message: string) {
    super(`PocketBase admin auth failed: ${message}`);
  }
}

export class PocketbaseHealthError extends Error {
  override readonly name = "PocketbaseHealthError";
  constructor(readonly baseUrl: string, override readonly cause?: unknown) {
    super(`PocketBase health probe failed at ${baseUrl}`);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FetchLike = typeof fetch;

export type PocketbaseHttpOpts = {
  baseUrl: string;
  fetchImpl?: FetchLike;
};

export type AdminAuthOpts = PocketbaseHttpOpts & {
  email: string;
  password: string;
};

export type AdminAuthResult = {
  token: string;
  adminId: string;
};

export type AuthorizedHttpOpts = PocketbaseHttpOpts & {
  token: string;
};

// PocketBase admin collection JSON. We keep the schema loose -- only the
// fields the export step needs are typed. Everything else passes through.
export type PocketbaseCollectionDto = {
  id: string;
  name: string;
  type: string;
  schema: Array<{
    name: string;
    type: string;
    required?: boolean;
    unique?: boolean;
    options?: Record<string, unknown>;
  }>;
  listRule?: string | null;
  viewRule?: string | null;
  createRule?: string | null;
  updateRule?: string | null;
  deleteRule?: string | null;
  indexes?: string[];
};

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export async function healthProbe(opts: PocketbaseHttpOpts): Promise<boolean> {
  const fetcher = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const url = joinUrl(opts.baseUrl, "/api/health");
  try {
    const res = await fetcher(url);
    return res.ok;
  } catch (cause) {
    throw new PocketbaseHealthError(opts.baseUrl, cause);
  }
}

export async function authenticateAdmin(
  opts: AdminAuthOpts
): Promise<AdminAuthResult> {
  const fetcher = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const url = joinUrl(opts.baseUrl, "/api/admins/auth-with-password");
  const res = await fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: opts.email, password: opts.password }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new PocketbaseAuthError(`${res.status} ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as {
    token?: string;
    admin?: { id?: string };
  };
  if (!body.token || !body.admin?.id) {
    throw new PocketbaseAuthError("response missing token or admin.id");
  }
  return { token: body.token, adminId: body.admin.id };
}

export async function listCollections(
  opts: AuthorizedHttpOpts
): Promise<PocketbaseCollectionDto[]> {
  const fetcher = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  // PocketBase paginates collections; 200/page is well above any realistic
  // venture's collection count.
  const url = joinUrl(opts.baseUrl, "/api/collections?perPage=200");
  const res = await fetcher(url, {
    headers: { Authorization: opts.token },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new PocketbaseHttpError("GET", url, res.status, text);
  }
  const body = (await res.json()) as { items?: PocketbaseCollectionDto[] };
  return body.items ?? [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function joinUrl(base: string, path: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}
