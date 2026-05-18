// Thin HTTP helpers for the Postiz REST API.
//
// Mirrors the FetchLike-injection pattern from
// @founder-os/backend-providers/supabase-http.ts so the vitest suite
// can pass a stub fetch and never touch the network.
//
// Postiz API surface used here (verified against gitroomhq/postiz-app
// docs at module-write time, 2026-05-15):
//   GET  /api/v1/health                  -> 200 OK
//   GET  /api/v1/integrations            -> [{ identifier: "x", ... }, ...]
//   POST /api/v1/upload  (multipart)     -> { id, url }
//   POST /api/v1/posts                   -> { posts: [{ id, releaseURL, integration }] }
//
// Auth: every request carries `Authorization: <api-key>` (Postiz uses
// raw token, not "Bearer <token>"). The token is read from the env var
// named in PostizConfig.apiKeyEnvVar by the adapter -- this module
// receives it as an opaque string.

export type FetchLike = typeof fetch;

export type PostizHttpOpts = {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: FetchLike;
  /**
   * Hard cap on round-trip wall time. Default 30s for control-plane
   * calls (health, integrations, posts); upload uses a higher cap
   * passed explicitly.
   */
  timeoutMs?: number;
};

export class PostizHttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(method: string, path: string, status: number, body: string) {
    super(
      `Postiz ${method} ${path}: ${status} ${body.slice(0, 200).trim()}`
    );
    this.name = "PostizHttpError";
    this.status = status;
    this.body = body;
  }
}

export class PostizHealthError extends Error {
  constructor(baseUrl: string, cause: string) {
    super(`Postiz health probe failed for ${baseUrl}: ${cause}`);
    this.name = "PostizHealthError";
  }
}

export class PostizMediaUploadError extends Error {
  constructor(path: string, cause: string) {
    super(`Postiz media upload failed for ${path}: ${cause}`);
    this.name = "PostizMediaUploadError";
  }
}

export class PostizRemoteHostBlockedError extends Error {
  constructor(baseUrl: string) {
    super(
      `Postiz baseUrl "${baseUrl}" is non-local and allowRemoteOnly is set. ` +
        `Either flip social.postiz.allowRemoteOnly off, or point at a localhost / LAN instance.`
    );
    this.name = "PostizRemoteHostBlockedError";
  }
}

// ---------------------------------------------------------------------------
// Local-host guard (mirrors crm-providers' assertLocalHost shape)
// ---------------------------------------------------------------------------

const LOCAL_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127(\.\d{1,3}){3}$/,
  /^10(\.\d{1,3}){3}$/,
  /^192\.168(\.\d{1,3}){2}$/,
  /^172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}$/,
  /\.local$/i,
];

/**
 * Assert the URL points at a local host. Used when the venture sets
 * social.postiz.allowRemoteOnly === true.
 */
export function assertLocalPostizHost(baseUrl: string): void {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    throw new PostizRemoteHostBlockedError(baseUrl);
  }
  for (const pat of LOCAL_HOSTNAME_PATTERNS) {
    if (pat.test(hostname)) return;
  }
  throw new PostizRemoteHostBlockedError(baseUrl);
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

async function timed<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T>([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * GET /api/v1/health -- returns true on 200, throws PostizHealthError
 * with the underlying cause on anything else.
 */
export async function postizHealthProbe(
  opts: PostizHttpOpts
): Promise<boolean> {
  const f = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl.replace(/\/$/, "")}/api/v1/health`;
  let resp: Response;
  try {
    resp = await timed(
      f(url, { headers: { Authorization: opts.apiKey } }),
      opts.timeoutMs ?? 30_000,
      `Postiz GET ${url}`
    );
  } catch (err) {
    throw new PostizHealthError(opts.baseUrl, (err as Error).message);
  }
  if (!resp.ok) {
    const body = await safeReadBody(resp);
    throw new PostizHealthError(
      opts.baseUrl,
      `${resp.status} ${body.slice(0, 80)}`
    );
  }
  return true;
}

export type PostizIntegration = {
  identifier: string;
  name?: string;
  status?: string;
};

/**
 * GET /api/v1/integrations -- which platforms the Postiz instance has
 * authenticated with the user's accounts. Mapped to SocialLoginState by
 * the adapter.
 */
export async function listPostizIntegrations(
  opts: PostizHttpOpts
): Promise<PostizIntegration[]> {
  const f = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl.replace(/\/$/, "")}/api/v1/integrations`;
  const resp = await timed(
    f(url, { headers: { Authorization: opts.apiKey } }),
    opts.timeoutMs ?? 30_000,
    `Postiz GET ${url}`
  );
  if (!resp.ok) {
    throw new PostizHttpError(
      "GET",
      "/api/v1/integrations",
      resp.status,
      await safeReadBody(resp)
    );
  }
  const json = (await resp.json()) as unknown;
  if (!Array.isArray(json)) return [];
  return json.filter(
    (x): x is PostizIntegration =>
      typeof x === "object" &&
      x !== null &&
      typeof (x as PostizIntegration).identifier === "string"
  );
}

export type PostizUploadResult = {
  id: string;
  url?: string;
};

/**
 * POST /api/v1/upload -- two-step media upload. Postiz returns an ID
 * the post body references. Adapter caches by (sha256, baseUrl) so the
 * same media file isn't re-uploaded for repeat posts.
 */
export async function uploadPostizMedia(
  opts: PostizHttpOpts,
  file: { data: Uint8Array; filename: string; contentType: string },
  uploadTimeoutMs = 5 * 60_000
): Promise<PostizUploadResult> {
  const f = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl.replace(/\/$/, "")}/api/v1/upload`;
  const form = new FormData();
  // Copy into a fresh ArrayBuffer-backed Uint8Array so the Blob ctor
  // gets a non-SharedArrayBuffer source (Node 20 lib.dom stricter).
  const owned = new Uint8Array(file.data.byteLength);
  owned.set(file.data);
  const blob = new Blob([owned.buffer], { type: file.contentType });
  form.append("file", blob, file.filename);
  let resp: Response;
  try {
    resp = await timed(
      f(url, {
        method: "POST",
        headers: { Authorization: opts.apiKey },
        body: form,
      }),
      uploadTimeoutMs,
      `Postiz POST ${url}`
    );
  } catch (err) {
    throw new PostizMediaUploadError(file.filename, (err as Error).message);
  }
  if (!resp.ok) {
    throw new PostizMediaUploadError(
      file.filename,
      `${resp.status} ${(await safeReadBody(resp)).slice(0, 200)}`
    );
  }
  const json = (await resp.json()) as { id?: unknown; url?: unknown };
  if (typeof json.id !== "string") {
    throw new PostizMediaUploadError(
      file.filename,
      `upload response missing { id } -- got ${JSON.stringify(json).slice(0, 120)}`
    );
  }
  return { id: json.id, url: typeof json.url === "string" ? json.url : undefined };
}

export type PostizCreatePostRequest = {
  posts: Array<{
    integration: string;
    content: string;
    mediaIds?: string[];
  }>;
  scheduleAt?: string;
};

export type PostizCreatePostRow = {
  integration: string;
  id?: string;
  releaseURL?: string;
  status?: string;
  error?: string;
};

export type PostizCreatePostResponse = {
  posts: PostizCreatePostRow[];
};

/**
 * POST /api/v1/posts -- create one Postiz post per integration. Returns
 * the per-integration result rows; the adapter maps them onto our
 * SocialResultRow shape.
 */
export async function createPostizPost(
  opts: PostizHttpOpts,
  body: PostizCreatePostRequest
): Promise<PostizCreatePostResponse> {
  const f = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl.replace(/\/$/, "")}/api/v1/posts`;
  const resp = await timed(
    f(url, {
      method: "POST",
      headers: {
        Authorization: opts.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    opts.timeoutMs ?? 60_000,
    `Postiz POST ${url}`
  );
  if (!resp.ok) {
    throw new PostizHttpError(
      "POST",
      "/api/v1/posts",
      resp.status,
      await safeReadBody(resp)
    );
  }
  const json = (await resp.json()) as unknown;
  if (
    typeof json !== "object" ||
    json === null ||
    !Array.isArray((json as PostizCreatePostResponse).posts)
  ) {
    return { posts: [] };
  }
  return json as PostizCreatePostResponse;
}

async function safeReadBody(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}
