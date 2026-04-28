import { NULL_TRANSPORT } from "./fallback.js";
/**
 * Transport registry.
 *
 * The library is transport-agnostic. Apps wire in a real transport at startup
 * (Anthropic API + Prompt Master skill, a local prompt-master binary, an HTTP
 * service, whatever). Until they do, the null transport is used and
 * optimization is a no-op pass-through.
 *
 * Why register at runtime instead of importing a default transport: the
 * optimizer might run inside a Tauri renderer, a Node CLI, a worker thread,
 * or a child process spawned by a build script. Each context has different
 * constraints (no fetch, no API keys, sandboxed FS). Letting the host app
 * choose keeps the package itself zero-config.
 */
import type { OptimizeInput, PromptMasterTransport } from "./types.js";

let activeTransport: PromptMasterTransport = NULL_TRANSPORT;

export function setTransport(transport: PromptMasterTransport): void {
  activeTransport = transport;
}

export function getTransport(): PromptMasterTransport {
  return activeTransport;
}

export function resetTransport(): void {
  activeTransport = NULL_TRANSPORT;
}

/**
 * Convenience: wrap an async function as a transport. Useful for ad-hoc
 * test harnesses or when the host app's optimizer is just a function and
 * doesn't need a class.
 *
 * Example:
 *   setTransport(asTransport("my-anthropic-skill", async (input) => {
 *     return { optimized: await callPromptMaster(input.prompt) };
 *   }));
 */
export function asTransport(
  name: string,
  fn: (input: OptimizeInput) => Promise<{ optimized: string }>
): PromptMasterTransport {
  return { name, optimize: fn };
}
