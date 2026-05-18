/**
 * A small Handlebars-subset template engine for handoff-pack templates.
 *
 * CLIENT-SAFE -- no node:* imports. The renderer and Node call sites
 * both go through this so the template syntax stays consistent across
 * the dispatch boundary.
 *
 * Why a subset rather than the upstream `handlebars` npm package?
 *   - Slice 2 ships ~120 LOC of focused syntax; adding the full
 *     handlebars dep (~80KB minified, plus an AST) for what tier-D
 *     templates need is overkill.
 *   - The full handlebars compiler uses `new Function()` to compile
 *     templates, which trips CSP in the Tauri webview. Avoiding it
 *     keeps the renderer-side rendering CSP-clean.
 *   - We support exactly what tier-A/B/C/D templates need today:
 *       {{var}}                  -- simple substitution, HTML-escaped
 *       {{{var}}}                -- raw substitution, not escaped (for
 *                                   HTML / markdown fragments)
 *       {{#if var}}...{{/if}}    -- conditional
 *       {{#each list}}...{{/each}} -- iteration (current item is `this`)
 *       {{!-- comment --}}       -- comment, stripped at render time
 *
 * If slice 3 needs partials / helpers / chained block expressions, we
 * upgrade to the real handlebars package and migrate; the call sites
 * stay the same because the signature is identical.
 */
import { HandoffPackTemplateError } from "./types.js";

export type TemplateContext = Readonly<Record<string, unknown>>;

export type TemplateRenderResult = {
  /** The rendered output. */
  output: string;
  /**
   * Placeholders the template referenced but the context didn't
   * resolve. Empty for fully-resolved renders. Tier-D templates
   * MAY return non-empty even on success (a TODO placeholder is
   * a feature, not a bug); the orchestrator decides.
   */
  unresolvedPlaceholders: ReadonlyArray<string>;
};

/**
 * Render a template against a context. `mode` controls error
 * behaviour:
 *   - "strict": throw HandoffPackTemplateError if any placeholder
 *     can't resolve. Used for tier-A/B/C templates where the runner
 *     guarantees every placeholder is set.
 *   - "lenient": replace unresolved `{{var}}` with a TODO callout,
 *     and surface the names in the result. Used for tier-D pure
 *     stubs where TODO callouts are the point.
 */
export function renderTemplate(
  source: string,
  context: TemplateContext,
  mode: "strict" | "lenient" = "strict"
): TemplateRenderResult {
  const unresolved = new Set<string>();
  // Strip {{!-- comments --}} first so they don't confuse the
  // mustache scanner. Use non-greedy match to handle multi-comment.
  let out = source.replace(/\{\{!--[\s\S]*?--\}\}/g, "");

  // Iterate {{#each ...}} blocks first (outermost match wins).
  out = expandEachBlocks(out, context, unresolved, mode);
  // Then conditional blocks.
  out = expandIfBlocks(out, context, unresolved, mode);
  // Finally bare variables. Triple-brace ({{{var}}}) before
  // double-brace ({{var}}) so the longer match takes precedence.
  out = expandRawVariables(out, context, unresolved, mode);
  out = expandEscapedVariables(out, context, unresolved, mode);

  const unresolvedList = Array.from(unresolved);
  if (mode === "strict" && unresolvedList.length > 0) {
    throw new HandoffPackTemplateError(unresolvedList);
  }
  return {
    output: out,
    unresolvedPlaceholders: Object.freeze(unresolvedList),
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Resolve a dotted path like "a.b.c" against an unknown-typed context. */
function lookup(
  context: TemplateContext,
  path: string
): { found: boolean; value: unknown } {
  if (path === "this") return { found: true, value: context };
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

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
};

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

function stringify(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function todoCallout(name: string): string {
  return `<span class="hp-todo" data-placeholder="${htmlEscape(name)}">TODO: ${htmlEscape(name)}</span>`;
}

function expandRawVariables(
  src: string,
  ctx: TemplateContext,
  unresolved: Set<string>,
  mode: "strict" | "lenient"
): string {
  return src.replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_match, path: string) => {
    const { found, value } = lookup(ctx, path);
    if (!found) {
      unresolved.add(path);
      return mode === "lenient" ? todoCallout(path) : "";
    }
    return stringify(value);
  });
}

function expandEscapedVariables(
  src: string,
  ctx: TemplateContext,
  unresolved: Set<string>,
  mode: "strict" | "lenient"
): string {
  return src.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
    const { found, value } = lookup(ctx, path);
    if (!found) {
      unresolved.add(path);
      return mode === "lenient" ? todoCallout(path) : "";
    }
    return htmlEscape(stringify(value));
  });
}

function expandIfBlocks(
  src: string,
  ctx: TemplateContext,
  unresolved: Set<string>,
  mode: "strict" | "lenient"
): string {
  // {{#if var}}body{{/if}}
  const pattern = /\{\{#if\s+([\w.]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g;
  return src.replace(pattern, (_match, path: string, body: string) => {
    const { found, value } = lookup(ctx, path);
    if (!found) {
      // Unresolved if-block evaluates falsey but is NOT an error in
      // lenient mode -- tier-D templates may probe for optional context.
      if (mode === "strict") unresolved.add(path);
      return "";
    }
    return isTruthy(value)
      ? // Recursively expand variables inside the matched body so
        // nested {{var}} inside an if-block still resolves.
        expandEscapedVariables(
          expandRawVariables(body, ctx, unresolved, mode),
          ctx,
          unresolved,
          mode
        )
      : "";
  });
}

function expandEachBlocks(
  src: string,
  ctx: TemplateContext,
  unresolved: Set<string>,
  mode: "strict" | "lenient"
): string {
  // {{#each list}}body{{/each}}. Inside body, "{{this}}" is the
  // current item; dotted paths off `this` work too.
  const pattern = /\{\{#each\s+([\w.]+)\s*\}\}([\s\S]*?)\{\{\/each\}\}/g;
  return src.replace(pattern, (_match, path: string, body: string) => {
    const { found, value } = lookup(ctx, path);
    if (!found) {
      if (mode === "strict") unresolved.add(path);
      return "";
    }
    if (!Array.isArray(value)) return "";
    return value
      .map((item) => {
        const itemCtx: TemplateContext =
          typeof item === "object" && item !== null
            ? (item as TemplateContext)
            : { this: item };
        return expandEscapedVariables(
          expandRawVariables(body, itemCtx, unresolved, mode),
          itemCtx,
          unresolved,
          mode
        );
      })
      .join("");
  });
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
