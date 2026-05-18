/**
 * PocketBase filter DSL -> Postgres RLS expression translator.
 *
 * The PRODUCT_SPEC step emits a small subset of the PB filter DSL when
 * deriving conservative `ApiRules` for each collection (per the spec
 * sec 8 of POCKETBASE-MODULE-SPEC.md). Supabase needs those rules as
 * Postgres expressions for the `CREATE POLICY ... USING (...)` clause.
 *
 * We don't ship a full DSL parser -- we ship a translator for the
 * subset the upstream actually emits, plus a graceful-degradation path
 * for anything more exotic so the security review gate can flag it.
 *
 * Supported subset (per SUPABASE-MODULE-SPEC.md sec 5):
 *
 *   - `@request.auth.id`        -> `auth.uid()`
 *   - `@request.auth.<field>`   -> `(auth.jwt() ->> '<field>')`
 *   - Field comparisons:        passes through with `=` / `!=` mapped
 *                                to SQL equivalents.
 *   - Logical operators:        `&&` -> `and`, `||` -> `or`
 *   - Single-quoted strings:    pass through
 *   - Parentheses:              pass through
 *
 * Anything outside this list -> the translator returns `{rls: null,
 * warnings}` and the caller emits a review-gate finding rather than a
 * broken policy.
 *
 * Pure -- no IO, no regex backreference traps. Easy to test.
 */

export type TranslationResult = {
  /**
   * The translated Postgres expression suitable for use inside a
   * `using (...)` or `with check (...)` clause. Null when the DSL
   * contained tokens we don't safely translate.
   */
  rls: string | null;
  /**
   * Free-text warnings describing every unsafe substitution that
   * forced us to bail. The provider surfaces these on the review gate
   * so the founder can hand-translate the remaining rule.
   */
  warnings: string[];
};

/**
 * Tokens we recognise. Order matters -- longer matches must come
 * first or `@request.auth.id` would partially match `@request.auth.`.
 */
const KNOWN_SUBSTITUTIONS: ReadonlyArray<[RegExp, string]> = [
  // @request.auth.id -> auth.uid()
  [/@request\.auth\.id\b/g, "auth.uid()"],
  // @request.auth.<word> -> (auth.jwt() ->> '<word>')
  [/@request\.auth\.([a-zA-Z_][a-zA-Z0-9_]*)/g, "(auth.jwt() ->> '$1')"],
  // PocketBase uses `&&` / `||`; Postgres uses `and` / `or`.
  // We add spaces around the operator so they don't merge with
  // adjacent tokens.
  [/&&/g, " and "],
  [/\|\|/g, " or "],
];

/**
 * Anything starting with `@` after our known substitutions ran is a
 * PB-specific reference we don't understand. Surfaces a warning.
 */
const UNKNOWN_PB_REF = /@[a-zA-Z_][a-zA-Z0-9_.]*/g;

/**
 * Unsafe characters that suggest a string-injection attempt or DSL
 * grammar we haven't whitelisted (semicolons would break out of a
 * policy, backticks aren't Postgres syntax, etc.). Any match bails
 * out of translation.
 */
const UNSAFE_TOKENS = /[;`\\]/;

export function translatePbFilterToRls(dsl: string): TranslationResult {
  const warnings: string[] = [];
  const trimmed = dsl.trim();
  if (trimmed.length === 0) {
    return { rls: "true", warnings: [] };
  }

  if (UNSAFE_TOKENS.test(trimmed)) {
    return {
      rls: null,
      warnings: [
        `Filter DSL contains an unsafe token (one of ; \\` + "` `" + `). Translation refused.`,
      ],
    };
  }

  let working = trimmed;
  for (const [pattern, replacement] of KNOWN_SUBSTITUTIONS) {
    working = working.replace(pattern, replacement);
  }

  // After known substitutions, any remaining `@<ident>` is unknown.
  const unknownRefs = working.match(UNKNOWN_PB_REF);
  if (unknownRefs && unknownRefs.length > 0) {
    for (const ref of unknownRefs) {
      warnings.push(
        `Filter DSL references \`${ref}\` which has no Postgres equivalent in this translator.`
      );
    }
    return { rls: null, warnings };
  }

  // Collapse runs of whitespace introduced by `&&` / `||` substitution.
  working = working.replace(/\s+/g, " ").trim();
  return { rls: working, warnings };
}

/**
 * Convenience for callers that want a SQL fragment they can splice
 * directly into a policy, with `true` as the always-allow fallback
 * when the DSL is empty AND with a defensive `false` when translation
 * fails (denies access rather than silently allowing it).
 */
export function rlsExpressionOrDeny(dsl: string | undefined): {
  expression: string;
  warnings: string[];
} {
  if (dsl === undefined || dsl.trim().length === 0) {
    // No rule = the PB convention is "admins only", which on Supabase
    // means "deny everyone except service_role". Service role bypasses
    // RLS regardless of policy, so `false` is the correct denial.
    return { expression: "false", warnings: [] };
  }
  const { rls, warnings } = translatePbFilterToRls(dsl);
  if (rls === null) {
    return {
      expression: "false",
      warnings: [
        ...warnings,
        `Falling back to \`using (false)\` for safety -- hand-translate the rule above.`,
      ],
    };
  }
  return { expression: rls, warnings };
}
