/**
 * brand-chat / refs.ts -- pure helpers for image-reference handling
 * in the Brand chat panel.
 *
 * Gemini CLI parses `@<path>` tokens in a prompt as multimodal file
 * inclusions before processing the prompt itself. We only need to
 * prepend those tokens to the user's prose -- no SDK call, no Rust
 * change. Verified on 2026-04-29 with `gemini -p` against an absolute
 * Windows path on the user's installed CLI.
 *
 * Keeping this in its own module so the chat panel stays lean and the
 * helpers are unit-testable without React.
 */

/**
 * Build a single CLI prompt string out of (a) reference image
 * absolute paths and (b) the user's prose. The CLI consumes `@path`
 * tokens before processing the rest of the prompt, so order matters:
 * refs first, prose second, joined by a blank line for readability in
 * the persisted chat history.
 *
 * Empty refs returns the prose unchanged so the helper is safe to
 * always-call from the chat send path.
 */
export function injectImageRefs(prompt: string, refs: readonly string[]): string {
  if (!refs.length) return prompt;
  const tokens = refs.map((p) => `@${p}`).join(" ");
  return `${tokens}\n\n${prompt}`;
}

/**
 * True if `candidate` is an absolute path that lives under `parent`.
 * Used as a soft guard in v1 so a malformed prompt cannot reference
 * arbitrary files outside the venture's refs dir. v0 stub does not
 * enforce this -- refs are the absolute path of whatever file the
 * user picked from the OS dialog, which is fine since the user
 * themselves chose it.
 */
export function isPathUnder(candidate: string, parent: string): boolean {
  if (!candidate || !parent) return false;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/g, "");
  const c = norm(candidate);
  const p = norm(parent);
  return c === p || c.startsWith(`${p}/`);
}
