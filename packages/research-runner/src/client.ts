/**
 * Thin HTTP client for the research-py FastAPI sidecar.
 *
 * Uses the global fetch -- works in Node 18+, browsers, and the Tauri
 * webview. No node:* imports, no env reads. Pass baseUrl explicitly
 * (the desktop wires it from a Tauri config command).
 *
 * Errors: every method throws ResearchClientError on non-2xx or
 * network failure. The error carries the HTTP status (or 0 for
 * network) and any parsed response body so callers can render
 * something useful.
 */

import type {
  CompetitorScanAcceptedResponse,
  CompetitorScanRequest,
  DeepResearchAcceptedResponse,
  DeepResearchRequest,
  HealthResponse,
  IcpAcceptedResponse,
  IcpRequest,
  JobListResponse,
  JobRecord,
} from "./types.js";

export interface ResearchClientOptions {
  /** Base URL of the research-py service. e.g. "http://localhost:3030".
   *  No trailing slash; the client appends paths. */
  baseUrl: string;
  /** Per-call timeout (ms). Default 30_000. Polls override this with
   *  a short timeout (the deep-research job itself can run minutes,
   *  but a single GET should respond in seconds). */
  timeoutMs?: number;
  /** Optional fetch override for tests. */
  fetchImpl?: typeof fetch;
}

/** Error thrown on every non-2xx or network failure. */
export class ResearchClientError extends Error {
  override readonly name = "ResearchClientError";
  /** HTTP status code, or 0 for network/timeout. */
  readonly status: number;
  /** The parsed JSON response body when the server returned one. */
  readonly body: unknown;
  /** True when the underlying cause was AbortError / fetch failure. */
  readonly isNetwork: boolean;

  constructor(message: string, opts: { status: number; body?: unknown; cause?: unknown }) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.status = opts.status;
    this.body = opts.body;
    this.isNetwork = opts.status === 0;
  }
}

export class ResearchClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ResearchClientOptions) {
    if (!opts.baseUrl) {
      throw new Error("ResearchClient: baseUrl is required");
    }
    // Strip trailing slash so we can do `${baseUrl}/path`.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    // Bind to globalThis so the browser/Tauri webview accepts the call.
    // Without the bind, calling `this.fetchImpl(url)` later sets `this` to
    // the ResearchClient instance, and the webview throws
    // "Failed to execute 'fetch' on 'Window': Illegal invocation".
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  // ---------- /health ----------

  async health(): Promise<HealthResponse> {
    return await this.request<HealthResponse>("GET", "/health");
  }

  // ---------- /research/deep ----------

  async createDeepResearch(req: DeepResearchRequest): Promise<DeepResearchAcceptedResponse> {
    return await this.request<DeepResearchAcceptedResponse>(
      "POST",
      "/research/deep",
      req,
    );
  }

  // ---------- /research/competitors ----------

  async scanCompetitors(req: CompetitorScanRequest): Promise<CompetitorScanAcceptedResponse> {
    return await this.request<CompetitorScanAcceptedResponse>(
      "POST",
      "/research/competitors",
      req,
    );
  }

  // ---------- /research/icp ----------

  async synthesizeIcp(req: IcpRequest): Promise<IcpAcceptedResponse> {
    return await this.request<IcpAcceptedResponse>(
      "POST",
      "/research/icp",
      req,
    );
  }

  // ---------- /research/jobs ----------

  async getJob(jobId: string): Promise<JobRecord> {
    if (!jobId) {
      throw new Error("ResearchClient.getJob: jobId is required");
    }
    return await this.request<JobRecord>(
      "GET",
      `/research/jobs/${encodeURIComponent(jobId)}`,
    );
  }

  async listJobs(): Promise<JobListResponse> {
    return await this.request<JobListResponse>("GET", "/research/jobs");
  }

  // ---------- internal ----------

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    overrideTimeoutMs?: number,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutMs = overrideTimeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: body !== undefined
          ? { "Content-Type": "application/json", "Accept": "application/json" }
          : { "Accept": "application/json" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const isAbort = (err as { name?: string } | null)?.name === "AbortError";
      const msg = isAbort
        ? `Network timeout after ${timeoutMs}ms: ${method} ${path}`
        : `Network error: ${method} ${path} -- ${stringifyError(err)}`;
      throw new ResearchClientError(msg, { status: 0, cause: err });
    }
    clearTimeout(timer);

    // Try to parse body as JSON regardless of status -- FastAPI returns
    // {detail: "..."} on errors, which is useful to surface.
    let parsed: unknown = undefined;
    const text = await response.text();
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      const detail = extractDetail(parsed);
      throw new ResearchClientError(
        `${method} ${path} failed: HTTP ${response.status}${detail ? ` -- ${detail}` : ""}`,
        { status: response.status, body: parsed },
      );
    }

    return parsed as T;
  }
}

// ---------- helpers ----------

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function extractDetail(body: unknown): string | undefined {
  if (body && typeof body === "object" && "detail" in body) {
    const d = (body as { detail: unknown }).detail;
    if (typeof d === "string") return d;
    try {
      return JSON.stringify(d);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
