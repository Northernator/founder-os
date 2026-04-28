/**
 * Stable hashing for cache keys.
 *
 * SHA-256 over a canonical serialisation of the inputs that affect output.
 * Prompt + model + lossBudget + cache version. Stable across processes and
 * runtimes — same inputs always produce the same key.
 *
 * Uses the Web Crypto API (globalThis.crypto.subtle), which is standardised
 * across Node 16+, Bun, Deno, modern browsers, and the Tauri WebView. This
 * keeps the core dispatcher importable from any runtime — no node:* imports
 * leaking into the client bundle and crashing module evaluation.
 */

/**
 * Bump this when the upstream Prompt Master skill changes behaviour in a way
 * that should invalidate previously cached results. Simple and explicit.
 */
export const PROMPT_MASTER_CACHE_VERSION = 1;

export interface HashInputs {
  prompt: string;
  model?: string;
  maxLossBudget?: number;
}

export async function hashKey(inputs: HashInputs): Promise<string> {
  const canonical = JSON.stringify({
    v: PROMPT_MASTER_CACHE_VERSION,
    p: inputs.prompt,
    m: inputs.model ?? "",
    l: inputs.maxLossBudget ?? 0,
  });
  const data = new TextEncoder().encode(canonical);
  const buf = await globalThis.crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  // Build the hex string by reading bytes via DataView — that returns a
  // guaranteed `number`, side-stepping `noUncheckedIndexedAccess` which
  // would otherwise type `bytes[i]` as `number | undefined`.
  const view = new DataView(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += view.getUint8(i).toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Rough token estimate. We don't ship a tokenizer to avoid adding a heavy
 * dependency for what is essentially a savings counter. ~4 chars per token
 * is the standard back-of-envelope for English prose; close enough for
 * "tokens saved" telemetry. Real model billing uses the model's tokenizer.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
