/**
 * Ollama HTTP client for the Mission Control Ollama tab.
 *
 * Talks to whatever URL is in `founderCowork.providers.ollama.baseUrl`
 * (default http://localhost:11434). We deliberately use the non-streaming
 * /api/generate endpoint - streaming would require either a long-lived
 * webview message channel or chunked toasts, both of which add complexity
 * we don't need yet.
 */

import type {
  OllamaListModelsResponse,
  OllamaModelInfo,
  OllamaRunResponse,
} from "@founder-os/mission-control-protocol";

interface OllamaTagsResponse {
  models?: Array<{
    name: string;
    modified_at?: string;
    size?: number;
  }>;
}

interface OllamaGenerateResponse {
  model: string;
  response: string;
  total_duration?: number; // ns
}

const TIMEOUT_MS = 60_000;

export async function listModels(baseUrl: string): Promise<OllamaListModelsResponse> {
  const url = baseUrl.replace(/\/+$/, "") + "/api/tags";
  const res = await fetchJson<OllamaTagsResponse>(url, { method: "GET" });
  const models: OllamaModelInfo[] = (res.models ?? []).map((m) => ({
    name: m.name,
    modifiedAt: m.modified_at,
    sizeBytes: m.size,
  }));
  return { baseUrl, models };
}

export async function generate(
  baseUrl: string,
  model: string,
  prompt: string
): Promise<OllamaRunResponse> {
  const url = baseUrl.replace(/\/+$/, "") + "/api/generate";
  const body = {
    model,
    prompt,
    stream: false,
  };
  const res = await fetchJson<OllamaGenerateResponse>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    model: res.model,
    response: res.response,
    totalDurationMs:
      typeof res.total_duration === "number"
        ? Math.round(res.total_duration / 1_000_000)
        : undefined,
  };
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        "Ollama " + res.status + " " + res.statusText + (text ? " :: " + text.slice(0, 200) : "")
      );
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        "Ollama request to " +
          url +
          " timed out after " +
          TIMEOUT_MS +
          "ms. " +
          "Is the Ollama server running?"
      );
    }
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ECONNREFUSED"
    ) {
      throw new Error(
        "Connection refused at " +
          url +
          ". " +
          "Start Ollama (`ollama serve`) or check founderCowork.providers.ollama.baseUrl."
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
