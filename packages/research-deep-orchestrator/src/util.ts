/**
 * Small JSON-from-LLM helper. Claude / Gemini occasionally wrap structured
 * output in a ```json … ``` fence despite system-prompt instructions to
 * emit raw JSON. Strip the fence (and any leading "Here is the JSON:"
 * preamble) before parsing — otherwise we'd surface a SyntaxError that
 * is really a prompt-adherence quirk.
 *
 * Throws a SyntaxError with the prefix "[llm-json] " when the response
 * still doesn't parse after fence-stripping, so callers can re-throw
 * with their phase-specific error type without losing the cause.
 */
export function parseLlmJson<T = unknown>(response: string): T {
  const trimmed = response.trim();

  // Fast path: already raw JSON.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as T;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SyntaxError(`[llm-json] ${msg}`);
    }
  }

  // Code-fence path: extract the first ```json … ``` (or generic ``` … ```) block.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch && fenceMatch[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim()) as T;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SyntaxError(`[llm-json] fenced JSON failed to parse: ${msg}`);
    }
  }

  // Last-ditch: find the first balanced { … } substring and try that.
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate) as T;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SyntaxError(`[llm-json] braced JSON failed to parse: ${msg}`);
    }
  }

  throw new SyntaxError(
    `[llm-json] response did not contain JSON: ${trimmed.slice(0, 80)}`,
  );
}
