/**
 * Minimal Frappe REST client.
 *
 * Two non-negotiables enforced here:
 *
 *  1. **Local-only host guard.** Every request runs through ensureLocalHost
 *     before any socket opens. Hostnames outside CRM_HTTP_LOCAL_HOSTNAMES
 *     get rejected with FrappeNonLocalHostError. This is the safety net
 *     that makes "local-only" a property of the code, not just the docs.
 *
 *  2. **Auth header redaction.** The Authorization header carries
 *     `token <key>:<secret>`. The logging surface in this module never
 *     prints the header value -- only `Authorization: token <redacted>`.
 *
 * Targets Frappe CRM v1.70.x. The wrapper sticks to /api/resource/<DocType>
 * endpoints where possible -- they're the most stable across versions.
 */

import { CRM_HTTP_LOCAL_HOSTNAMES } from "@founder-os/crm-core";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class FrappeNonLocalHostError extends Error {
  override readonly name = "FrappeNonLocalHostError";
  constructor(readonly hostname: string) {
    super(
      `Refusing to send a Frappe request to non-local host "${hostname}". ` +
        `Allowed hostnames: ${CRM_HTTP_LOCAL_HOSTNAMES.join(", ")}. ` +
        `Modify CRM_HTTP_LOCAL_HOSTNAMES in @founder-os/crm-core if you need to change this.`
    );
  }
}

export class FrappeHttpError extends Error {
  override readonly name = "FrappeHttpError";
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly body: string,
    readonly method: string,
    readonly url: string
  ) {
    super(`Frappe ${method} ${url} → ${status} ${statusText}`);
  }
}

export class FrappeAuthError extends Error {
  override readonly name = "FrappeAuthError";
  constructor(message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FrappeClientOpts = {
  /**
   * Site URL. Must resolve to a host in CRM_HTTP_LOCAL_HOSTNAMES; anything
   * else throws FrappeNonLocalHostError at client construction.
   */
  siteUrl: string;
  /**
   * Frappe API key. Pair with apiSecret to form the Authorization header.
   * Read from an encrypted file at the call-site, never logged or
   * persisted to disk by this module.
   */
  apiKey: string;
  apiSecret: string;
  /**
   * Pinned client version sent in the User-Agent header so Frappe audit
   * logs can attribute changes back to the runner. Caller-provided so
   * tests can pin a known value.
   */
  clientVersion?: string;
  /**
   * Frappe site name header. Defaults to the hostname of siteUrl which
   * is sufficient for the default Docker bootstrap.
   */
  siteNameHeader?: string;
  /**
   * Optional injected fetch (tests use this). Defaults to globalThis.fetch
   * bound to globalThis to avoid the "Illegal invocation" trap when
   * defaulting from an injected param.
   */
  fetchImpl?: typeof fetch;
};

export type FrappeRequestOpts = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /**
   * Path relative to siteUrl, must start with "/api/". For example
   *   "/api/resource/CRM Lead"
   * The client URL-encodes the path segments for you.
   */
  path: string;
  /**
   * JSON-serialisable body for POST/PUT. Ignored for GET/DELETE.
   */
  body?: unknown;
  /**
   * Query params appended to the URL. Values get encodeURIComponent'd.
   */
  query?: Record<string, string | number>;
  /**
   * Optional AbortSignal -- forwarded into fetch.
   */
  signal?: AbortSignal;
};

export interface FrappeClient {
  readonly siteUrl: string;
  request<T = unknown>(opts: FrappeRequestOpts): Promise<T>;
  /**
   * GET /api/method/ping -- light reachability probe used by available().
   * Resolves true when the site responds 200, false otherwise.
   */
  ping(signal?: AbortSignal): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Host guard
// ---------------------------------------------------------------------------

function ensureLocalHost(siteUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(siteUrl);
  } catch (cause) {
    throw new Error(`Invalid siteUrl "${siteUrl}": ${(cause as Error).message}`);
  }
  if (!CRM_HTTP_LOCAL_HOSTNAMES.includes(parsed.hostname)) {
    throw new FrappeNonLocalHostError(parsed.hostname);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createFrappeClient(opts: FrappeClientOpts): FrappeClient {
  // Validate eagerly at construction so misconfigured callers fail fast.
  const baseUrl = ensureLocalHost(opts.siteUrl);

  if (!opts.apiKey || !opts.apiSecret) {
    throw new FrappeAuthError("Frappe client requires both apiKey and apiSecret.");
  }

  // Avoid "Illegal invocation" by binding to globalThis (per the
  // feedback_browser_fetch_illegal_invocation memory).
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);

  const clientVersion = opts.clientVersion ?? "@founder-os/crm-providers@0.1.0";
  const siteNameHeader = opts.siteNameHeader ?? baseUrl.hostname;

  function authHeader(): string {
    return `token ${opts.apiKey}:${opts.apiSecret}`;
  }

  async function request<T = unknown>(req: FrappeRequestOpts): Promise<T> {
    if (!req.path.startsWith("/api/")) {
      throw new Error(`Frappe path must start with "/api/", got "${req.path}".`);
    }

    // Build the request URL. Re-running the host guard catches any path-
    // smuggling attempt that injects a // or scheme into the path.
    const url = new URL(req.path, baseUrl);
    ensureLocalHost(url.toString());

    if (req.query) {
      for (const [k, v] of Object.entries(req.query)) {
        url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: authHeader(),
      "User-Agent": clientVersion,
      "X-Frappe-Site-Name": siteNameHeader,
    };

    let body: string | undefined;
    if (req.method === "POST" || req.method === "PUT") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.body ?? {});
    }

    const res = await fetchImpl(url.toString(), {
      method: req.method,
      headers,
      body,
      signal: req.signal,
    });

    if (!res.ok) {
      const text = await safeReadText(res);
      throw new FrappeHttpError(res.status, res.statusText, text, req.method, url.toString());
    }

    if (res.status === 204) {
      return undefined as unknown as T;
    }

    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      return (await res.json()) as T;
    }
    return (await res.text()) as unknown as T;
  }

  async function ping(signal?: AbortSignal): Promise<boolean> {
    try {
      await request({ method: "GET", path: "/api/method/ping", signal });
      return true;
    } catch {
      return false;
    }
  }

  return { siteUrl: baseUrl.toString(), request, ping };
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Log redaction helper
// ---------------------------------------------------------------------------

/**
 * Replaces the apiKey/secret in a header dump with a redaction marker.
 * Callers that want to log a request for debugging should run their
 * headers through this first. The runner's log-strings drift test
 * asserts no Authorization line in any log message contains a real token.
 */
export function redactAuthHeader(value: string): string {
  return value.replace(/token\s+\S+:\S+/g, "token <redacted>");
}
