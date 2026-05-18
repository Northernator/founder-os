/**
 * Collection -> Postgres DDL translator for the Supabase provider.
 *
 * The PRODUCT_SPEC step emits engine-agnostic Collections (per the
 * @founder-os/backend-core contract). This module turns each
 * Collection into:
 *
 *   - One `CREATE TABLE IF NOT EXISTS` statement (per the field
 *     mapping in SUPABASE-MODULE-SPEC.md sec 4).
 *   - One `CREATE INDEX IF NOT EXISTS` statement per requested index.
 *   - `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`.
 *   - Per-verb `DROP POLICY IF EXISTS` + `CREATE POLICY` pairs derived
 *     from `apiRules`, with the DSL translated by
 *     `translatePbFilterToRls()`.
 *
 * Pure -- no IO. The Supabase provider drives the actual HTTP calls
 * via `supabase-http.execSql()`.
 *
 * Idempotency contract: every statement is safe to re-run. Tables use
 * IF NOT EXISTS, indexes use IF NOT EXISTS, policies use DROP-then-
 * CREATE. This mirrors the "schema-step is declarative, not
 * incremental" stance in SUPABASE-MODULE-SPEC.md sec 2 (no migration
 * tracking).
 */

import type { Collection, Field, FieldKind } from "@founder-os/backend-core";

import { rlsExpressionOrDeny } from "./pb-filter-to-rls.js";

// ---------------------------------------------------------------------------
// FieldKind -> Postgres column type
// ---------------------------------------------------------------------------

/**
 * Per SUPABASE-MODULE-SPEC.md sec 4. Keep the doc and this table in
 * sync if you adjust either. `select` / `email` / `url` map to `text`
 * here; their constraint clauses are emitted separately by
 * `buildFieldConstraint()`.
 */
const POSTGRES_TYPE_BY_FIELD_KIND: Record<FieldKind, string> = {
  text: "text",
  longText: "text",
  richText: "text",
  email: "text",
  url: "text",
  number: "numeric",
  bool: "boolean",
  date: "timestamptz",
  select: "text",
  json: "jsonb",
  file: "text",
  relation: "uuid",
};

export function fieldKindToPostgresType(kind: FieldKind): string {
  return POSTGRES_TYPE_BY_FIELD_KIND[kind];
}

// ---------------------------------------------------------------------------
// Identifier safety
// ---------------------------------------------------------------------------

/**
 * Postgres identifiers in DDL must either be unquoted (case-folded to
 * lowercase, restricted character set) or double-quoted. Collection
 * names from upstream are already snake_case but we defend in depth
 * against a hand-edited canvas.
 *
 * Returns the safe-to-splice identifier. Throws on names that contain
 * anything weirder than letters / digits / underscore / hyphen.
 */
export function safeIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(
      `Refusing to splice identifier ${JSON.stringify(name)} into DDL: ` +
        "must match /^[a-zA-Z_][a-zA-Z0-9_]*$/."
    );
  }
  return name;
}

/**
 * Single-quote escape a string literal for safe DDL splicing. Used by
 * `select` options + `email` / `url` regex check constraints.
 */
function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// Field DDL fragments
// ---------------------------------------------------------------------------

/**
 * The `<name> <type> [not null] [default ...]` part of the column
 * definition. References + check constraints come from
 * `buildFieldConstraint()`.
 */
function buildColumnDefinition(field: Field): string {
  const ident = safeIdent(field.name);
  const type = fieldKindToPostgresType(field.kind);
  const nullClause = field.required ? " not null" : "";
  if (field.kind === "relation" && field.relatesTo) {
    const target = safeIdent(field.relatesTo);
    const cascade = field.cascadeDelete ? "cascade" : "set null";
    return `${ident} ${type} references ${target}(id) on delete ${cascade}${nullClause}`;
  }
  return `${ident} ${type}${nullClause}`;
}

/**
 * Trailing constraint clauses (UNIQUE + CHECK). UNIQUE is a separate
 * fragment (rather than inline) so the table CREATE can put all
 * constraints at the bottom; this keeps the SQL readable when there
 * are many fields.
 *
 * Returns an array of constraint clauses; the caller joins them with
 * commas inside the table body.
 */
function buildFieldConstraints(field: Field, tableName: string): string[] {
  const constraints: string[] = [];
  const ident = safeIdent(field.name);
  if (field.unique) {
    constraints.push(
      `constraint ${safeIdent(`${tableName}_${field.name}_unique`)} unique (${ident})`
    );
  }
  switch (field.kind) {
    case "email":
      // Cheap email regex -- doesn't try to be RFC-5322 compliant.
      constraints.push(
        `constraint ${safeIdent(`${tableName}_${field.name}_email`)} ` +
          `check (${ident} is null or ${ident} ~* ${sqlString("^[^@]+@[^@]+\\.[^@]+$")})`
      );
      break;
    case "url":
      constraints.push(
        `constraint ${safeIdent(`${tableName}_${field.name}_url`)} ` +
          `check (${ident} is null or ${ident} ~* ${sqlString("^https?://")})`
      );
      break;
    case "select":
      if (field.options && field.options.length > 0) {
        const inList = field.options.map((o) => sqlString(o)).join(", ");
        constraints.push(
          `constraint ${safeIdent(`${tableName}_${field.name}_in`)} ` +
            `check (${ident} is null or ${ident} in (${inList}))`
        );
      }
      break;
    // numeric / bool / date / json / file / text / longText / richText:
    // no inline check constraint by default. App-level validation.
    default:
      break;
  }
  return constraints;
}

// ---------------------------------------------------------------------------
// Table DDL
// ---------------------------------------------------------------------------

/**
 * Emit `CREATE TABLE IF NOT EXISTS <table> (...)` for a single
 * Collection. The first three columns are universal:
 *
 *   id          uuid primary key default gen_random_uuid()
 *   created_at  timestamptz not null default now()
 *   updated_at  timestamptz not null default now()
 *
 * Per-Field constraints follow. `updated_at` triggering (auto-touch
 * on UPDATE) is emitted as a separate trigger function in
 * `buildUpdatedAtTrigger()`.
 */
export function buildTableDdl(collection: Collection): string {
  const table = safeIdent(collection.name);
  const lines: string[] = [];
  lines.push(`create table if not exists public.${table} (`);
  const columns: string[] = [
    "id uuid primary key default gen_random_uuid()",
    "created_at timestamptz not null default now()",
    "updated_at timestamptz not null default now()",
  ];
  const constraintLines: string[] = [];
  for (const field of collection.fields) {
    columns.push(buildColumnDefinition(field));
    constraintLines.push(...buildFieldConstraints(field, collection.name));
  }
  const body = [...columns, ...constraintLines].map((c) => `  ${c}`).join(",\n");
  lines.push(body);
  lines.push(");");
  return lines.join("\n");
}

/**
 * Emit a trigger + helper that touches `updated_at` on every UPDATE.
 * One trigger per table. Idempotent via DROP TRIGGER IF EXISTS.
 */
export function buildUpdatedAtTrigger(collection: Collection): string {
  const table = safeIdent(collection.name);
  const trig = safeIdent(`${collection.name}_touch_updated_at`);
  return [
    `drop trigger if exists ${trig} on public.${table};`,
    `create trigger ${trig}`,
    `  before update on public.${table}`,
    `  for each row execute function public.fos_touch_updated_at();`,
  ].join("\n");
}

/**
 * The shared `fos_touch_updated_at()` function -- ships once per
 * project, not per table. The provider runs this in applySchema()
 * before any table DDL.
 */
export const TOUCH_UPDATED_AT_FUNCTION_SQL = `create or replace function public.fos_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;`;

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

/**
 * Translate Collection.indexes -- which the PB-flavoured upstream
 * leaves as opaque strings -- into safe `CREATE INDEX IF NOT EXISTS`
 * statements. Each entry is treated as a column name (the common
 * case). Expressions / partial indexes are NOT supported here -- a
 * future slice can extend with a richer index type if needed.
 */
export function buildIndexes(collection: Collection): string[] {
  const table = safeIdent(collection.name);
  return collection.indexes.map((indexCol) => {
    const col = safeIdent(indexCol);
    const idxName = safeIdent(`${collection.name}_${indexCol}_idx`);
    return `create index if not exists ${idxName} on public.${table}(${col});`;
  });
}

// ---------------------------------------------------------------------------
// RLS policies
// ---------------------------------------------------------------------------

export type RlsPolicyBuildResult = {
  /**
   * SQL statements to execute in order. Each is a complete statement
   * ending with `;`.
   */
  statements: string[];
  /**
   * Warnings the security review gate should surface. Empty when
   * every rule translated cleanly.
   */
  warnings: string[];
};

/**
 * The 5 ApiRules verbs each map to a CREATE POLICY. Order of the
 * Postgres clauses:
 *
 *   - SELECT/DELETE: only `USING (...)`.
 *   - INSERT:        only `WITH CHECK (...)`.
 *   - UPDATE:        both `USING (...)` AND `WITH CHECK (...)`.
 *
 * Per ApiRule semantics in @founder-os/backend-core:
 *   - undefined / empty rule  -> deny everyone (RLS-deny on this verb)
 *   - present rule            -> use the translated expression
 *
 * Service-role JWTs bypass RLS, so the schema step's own writes via
 * `execSql()` always succeed regardless of policy.
 */
export function buildRlsPolicies(collection: Collection): RlsPolicyBuildResult {
  const table = safeIdent(collection.name);
  const statements: string[] = [];
  const warnings: string[] = [];

  statements.push(`alter table public.${table} enable row level security;`);

  const verbs: Array<{
    verb: "select" | "insert" | "update" | "delete";
    dsl: string | undefined;
    pgVerb: string;
  }> = [
    { verb: "select", dsl: collection.apiRules.list, pgVerb: "select" },
    // The `view` rule in ApiRules is also SELECT (PB's `view` is
    // "single record read"); we collapse it into the same policy.
    // When both `list` and `view` are present, `list` wins -- consistent
    // with the conservative "least permissive" stance.
    { verb: "insert", dsl: collection.apiRules.create, pgVerb: "insert" },
    { verb: "update", dsl: collection.apiRules.update, pgVerb: "update" },
    { verb: "delete", dsl: collection.apiRules.delete, pgVerb: "delete" },
  ];

  for (const { verb, dsl, pgVerb } of verbs) {
    const policyName = safeIdent(`${collection.name}_${verb}`);
    const { expression, warnings: w } = rlsExpressionOrDeny(dsl);
    for (const warn of w) {
      warnings.push(`policy ${policyName}: ${warn}`);
    }
    // Drop + create == idempotent.
    statements.push(`drop policy if exists ${policyName} on public.${table};`);
    if (pgVerb === "insert") {
      statements.push(
        `create policy ${policyName} on public.${table} for insert with check (${expression});`
      );
    } else if (pgVerb === "update") {
      statements.push(
        `create policy ${policyName} on public.${table} for update using (${expression}) with check (${expression});`
      );
    } else {
      statements.push(
        `create policy ${policyName} on public.${table} for ${pgVerb} using (${expression});`
      );
    }
  }

  return { statements, warnings };
}

// ---------------------------------------------------------------------------
// Top-level entry point -- the applySchema() driver
// ---------------------------------------------------------------------------

export type ApplySchemaPlan = {
  /**
   * The exact list of SQL statements applySchema() runs through
   * `exec_sql()` in order. Surface this to the founder for review
   * before execution (slice 7 BackendTab affordance).
   */
  statements: string[];
  /**
   * Warnings from any rule that fell back to `using (false)`. The
   * schema step emits these on the security review gate.
   */
  warnings: string[];
};

export function buildApplySchemaPlan(collections: Collection[]): ApplySchemaPlan {
  const statements: string[] = [];
  const warnings: string[] = [];

  // 1. Ensure the shared updated_at function exists. Cheap to re-run
  // (CREATE OR REPLACE).
  statements.push(TOUCH_UPDATED_AT_FUNCTION_SQL);

  // 2. Per-collection: table -> indexes -> trigger -> RLS policies.
  for (const c of collections) {
    statements.push(buildTableDdl(c));
    for (const idx of buildIndexes(c)) statements.push(idx);
    statements.push(buildUpdatedAtTrigger(c));
    const { statements: rlsStatements, warnings: rlsWarnings } =
      buildRlsPolicies(c);
    statements.push(...rlsStatements);
    warnings.push(...rlsWarnings);
  }

  return { statements, warnings };
}
