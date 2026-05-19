/**
 * Slice 7 -- minimal Handlebars-subset engine for vault note templates.
 *
 * CLIENT-SAFE -- pure text in / text out, no node:* imports. Supports
 * exactly what the vault templates need:
 *
 *   {{var}}                  -- simple substitution (no HTML escaping;
 *                               markdown sinks don't want angle-bracket
 *                               escaping baked in)
 *   {{#if var}}...{{/if}}    -- conditional
 *   {{#each list}}...{{/each}} -- iteration; current item is `this`
 *   {{!-- comment --}}       -- comment, stripped at render time
 *
 * Why not depend on @founder-os/handoff-pack-providers? That package's
 * engine HTML-escapes by default (built for PDF rendering), which is
 * wrong for markdown output. Re-implementing the ~70 LOC we need keeps
 * vault notes free of accidental `&amp;` / `&lt;` artefacts.
 */
import { MarkdownVaultError } from "./types.js";

export type TemplateContext = Readonly<Record<string, unknown>>;

export type TemplateRenderResult = {
  output: string;
  unresolvedPlaceholders: string[];
};

export function renderVaultTemplate(
  source: string,
  context: TemplateContext
): TemplateRenderResult {
  const unresolved = new Set<string>();
  let out = source.replace(/\{\{!--[\s\S]*?--\}\}/g, "");
  out = expandEach(out, context, unresolved);
  out = expandIf(out, context, unresolved);
  out = expandVariables(out, context, unresolved);
  return { output: out, unresolvedPlaceholders: Array.from(unresolved) };
}

function lookup(
  context: TemplateContext,
  path: string
): { found: boolean; value: unknown } {
  if (path === "this") {
    // When a primitive is iterated by {{#each}}, the item is wrapped as
    // `{ this: <value> }` so dotted-path callers still work. Unwrap it
    // here so the bare `{{this}}` reference returns the primitive, not
    // the wrapper object stringified as JSON.
    if (
      context !== null &&
      typeof context === "object" &&
      "this" in (context as Record<string, unknown>)
    ) {
      return { found: true, value: (context as Record<string, unknown>)["this"] };
    }
    return { found: true, value: context };
  }
  const parts = path.split(".");
  let current: unknown = context;
  for (const part of parts) {
    if (current == null || typeof current !== "object") {
      return { found: false, value: undefined };
    }
    if (!(part in (current as Record<string, unknown>))) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[part];
  }
  return { found: true, value: current };
}

function stringify(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function isTruthy(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "string") return v.length > 0;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

function expandVariables(
  src: string,
  ctx: TemplateContext,
  unresolved: Set<string>
): string {
  return src.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
    const { found, value } = lookup(ctx, path);
    if (!found) {
      unresolved.add(path);
      return "";
    }
    return stringify(value);
  });
}

function expandIf(
  src: string,
  ctx: TemplateContext,
  unresolved: Set<string>
): string {
  const pattern = /\{\{#if\s+([\w.]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g;
  return src.replace(pattern, (_match, path: string, body: string) => {
    const { found, value } = lookup(ctx, path);
    if (!found) {
      // Unresolved if-block evaluates falsy -- templates may probe for
      // optional context. The orchestrator decides whether to surface
      // it as a warning via unresolvedPlaceholders.
      return "";
    }
    if (!isTruthy(value)) return "";
    // Recurse so nested {{var}} inside the body still resolves.
    return expandVariables(body, ctx, unresolved);
  });
}

function expandEach(
  src: string,
  ctx: TemplateContext,
  unresolved: Set<string>
): string {
  const pattern = /\{\{#each\s+([\w.]+)\s*\}\}([\s\S]*?)\{\{\/each\}\}/g;
  return src.replace(pattern, (_match, path: string, body: string) => {
    const { found, value } = lookup(ctx, path);
    if (!found) {
      unresolved.add(path);
      return "";
    }
    if (!Array.isArray(value)) return "";
    return value
      .map((item) => {
        const itemCtx: TemplateContext =
          typeof item === "object" && item !== null
            ? (item as TemplateContext)
            : { this: item };
        return expandVariables(body, itemCtx, unresolved);
      })
      .join("");
  });
}

/** Throws when a referenced template id is not in the registry. */
export function assertTemplateRegistered<T>(
  registry: ReadonlyMap<string, T>,
  noteType: string
): T {
  const tpl = registry.get(noteType);
  if (!tpl) {
    throw new MarkdownVaultError(`no template registered for noteType="${noteType}"`);
  }
  return tpl;
}
