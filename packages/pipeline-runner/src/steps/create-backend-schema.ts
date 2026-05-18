/**
 * createBackendSchemaStep -- slice 4 of backend arc.
 *
 * Reads `06_product/specs/spec-canvas.json` and derives one
 * backend-core Collection per entity in the spec's data model. Calls
 * `provider.applySchema()` so the underlying backend (tier_0 PocketBase
 * binary, or any of the stub tiers) materialises the schema. Writes the
 * derived Collection[] to disk at
 * `12_backend/derived-collections.json` so the runner has a stable
 * artifact to surface in the review gate even when the provider's own
 * idempotent-skip path short-circuits.
 *
 * Deterministic. No LLM calls -- the entity-field-type translation is
 * pinned in MAPPING_RULES below (spec sec 8) so the schema review gate
 * always sees the same shape from the same canvas. Slice 4 of the spec
 * is explicit about this: schema generation is deterministic; only
 * hook-stub synthesis (the next step) is LLM-aware.
 *
 * Idempotent: writes the derived JSON every run + delegates to the
 * provider's own applySchema() which is expected to be idempotent
 * (PocketBase migrations only apply the pending ones).
 *
 * Behaviour when spec-canvas.json is missing or malformed: degrades to
 * an empty collection list and emits a `notes` line. This keeps the
 * BACKEND stage runnable on ventures that haven't filled the spec yet
 * -- the schema review gate surfaces the empty list and the user can
 * either iterate on the spec or skip the stage entirely.
 */
import {
  type ApiRules,
  type Collection,
  type Field,
  type FieldKind,
  type BackendProvider,
} from "@founder-os/backend-core";
import {
  ProductSpecCanvasSchema,
  type Entity,
  type EntityField,
  type VentureManifest,
} from "@founder-os/domain";
import {
  getBackendDir,
  getSpecCanvasPath,
} from "@founder-os/workspace-core";

import type { Filesystem } from "../fs.js";

export type CreateBackendSchemaContext = {
  fs: Filesystem;
  manifest: VentureManifest;
  ventureRoot: string;
  provider: BackendProvider;
  /**
   * Pre-resolved baseUrl from the provision step. Required because
   * BackendProvider.applySchema() needs to know where to apply against.
   * For config_only this is empty string (provider handles it).
   */
  baseUrl: string;
  runId?: string;
};

export type CreateBackendSchemaResult = {
  status: "done";
  collections: Collection[];
  /**
   * Disk path of the derived-collections.json artifact -- always
   * written, even when the entity list is empty (the file then
   * contains an empty array).
   */
  derivedCollectionsPath: string;
  /**
   * Number of collections actually handed off to provider.applySchema().
   * Excludes the implicit `users` auth collection only if it was already
   * present in spec.
   */
  collectionsApplied: number;
  /**
   * Free-text notes the runner surfaces in logs + review-gate output.
   * Common cases: "spec-canvas.json missing", "0 entities -- nothing
   * to apply", "users collection synthesised".
   */
  notes: string[];
};

// ---------------------------------------------------------------------------
// Public mapping rules (spec sec 8). Exported so unit tests + downstream
// docs can read the canonical translation table without re-deriving it.
// ---------------------------------------------------------------------------

export const MAPPING_RULES: ReadonlyArray<{
  matches: (rawType: string) => boolean;
  kind: FieldKind;
}> = [
  { matches: (t) => /^email$/i.test(t), kind: "email" },
  { matches: (t) => /^url$|^uri$/i.test(t), kind: "url" },
  { matches: (t) => /^bool(ean)?$/i.test(t), kind: "bool" },
  { matches: (t) => /^(int|integer|number|numeric|float|decimal|money)/i.test(t), kind: "number" },
  { matches: (t) => /^date(time)?$|^timestamp$/i.test(t), kind: "date" },
  { matches: (t) => /^(json|jsonb|record|map|dict)/i.test(t), kind: "json" },
  { matches: (t) => /^(file|image|attachment|blob)/i.test(t), kind: "file" },
  { matches: (t) => /^(richtext|markdown|md)$/i.test(t), kind: "richText" },
  { matches: (t) => /^longtext$|^text$/i.test(t), kind: "longText" },
  { matches: (t) => /^enum/i.test(t) || /^select$/i.test(t), kind: "select" },
  { matches: (t) => /^uuid|^ulid|^cuid|^id$/i.test(t), kind: "text" },
  { matches: (t) => /^string|^varchar|^char/i.test(t), kind: "text" },
];

export function mapFieldType(rawType: string): FieldKind {
  const trimmed = rawType.trim();
  if (!trimmed) return "text";
  // Relation hints -- field type like "FK to User" / "relation<User>" / "User[]"
  if (/^(fk|relation|ref|foreignkey)/i.test(trimmed)) return "relation";
  if (/^\w+\[\]$/.test(trimmed)) return "relation";
  for (const rule of MAPPING_RULES) {
    if (rule.matches(trimmed)) return rule.kind;
  }
  // Default unrecognised types to long text -- safer than throwing,
  // surfaces in the review gate where the user can rename.
  return "longText";
}

// ---------------------------------------------------------------------------
// Conservative API-rule defaults per spec sec 8.
// ---------------------------------------------------------------------------

export function deriveDefaultApiRules(
  collectionName: string,
  hasOwnerField: boolean,
): ApiRules {
  if (collectionName === "users") {
    return {
      list: "id = @request.auth.id",
      view: "id = @request.auth.id",
      // Open signup -- review gate is the place to lock down if needed.
      create: "",
      update: "id = @request.auth.id",
      delete: "id = @request.auth.id",
    };
  }
  const signedInOnly = '@request.auth.id != ""';
  const ownerOnly = "@request.auth.id = owner.id";
  return {
    list: signedInOnly,
    view: signedInOnly,
    create: hasOwnerField ? ownerOnly : signedInOnly,
    update: hasOwnerField ? ownerOnly : signedInOnly,
    delete: hasOwnerField ? ownerOnly : signedInOnly,
  };
}

// ---------------------------------------------------------------------------
// Entity -> Collection translation
// ---------------------------------------------------------------------------

function snakeCase(input: string): string {
  return input
    .trim()
    .replace(/[\s-]+/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
}

function translateField(field: EntityField): Field {
  const kind = mapFieldType(field.type ?? "");
  const out: Field = {
    name: snakeCase(field.name || "field"),
    kind,
    required: Boolean(field.required),
    unique: false,
  };
  if (kind === "relation") {
    // Best-effort: peel a target name out of "<X>[]" or "relation<X>" /
    // "FK to <X>". Falls back to a placeholder when nothing matches.
    const raw = (field.type ?? "").trim();
    const arrayMatch = raw.match(/^(\w+)\[\]$/);
    const angleMatch = raw.match(/<(\w+)>/);
    const fkMatch = raw.match(/^(?:fk|foreignkey|relation|ref)\s+(?:to\s+)?(\w+)/i);
    const target =
      arrayMatch?.[1] ?? angleMatch?.[1] ?? fkMatch?.[1] ?? "unknown";
    out.relatesTo = snakeCase(target);
    out.cascadeDelete = false;
    out.maxSelect = arrayMatch ? undefined : 1;
  }
  return out;
}

function translateEntity(entity: Entity): Collection {
  const name = snakeCase(entity.name || entity.id || "entity");
  const fields: Field[] = entity.fields
    .filter((f: EntityField) => (f.name ?? "").trim().length > 0)
    .map(translateField);
  const hasOwner = fields.some((f: Field) => f.name === "owner" || f.name === "user");
  return {
    name,
    type: name === "users" ? "auth" : "base",
    fields,
    apiRules: deriveDefaultApiRules(name, hasOwner),
    indexes: [],
    softDelete: false,
  };
}

// ---------------------------------------------------------------------------
// Step entry point
// ---------------------------------------------------------------------------

export async function createBackendSchemaStep(
  ctx: CreateBackendSchemaContext,
): Promise<CreateBackendSchemaResult> {
  const notes: string[] = [];
  const collections: Collection[] = [];

  const specPath = getSpecCanvasPath(ctx.ventureRoot);
  if (!(await ctx.fs.exists(specPath))) {
    notes.push("spec-canvas.json missing -- BACKEND stage runs with 0 entities");
  } else {
    try {
      const raw = await ctx.fs.readFile(specPath);
      const parsed = ProductSpecCanvasSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        notes.push(
          `spec-canvas.json present but failed schema parse (${parsed.error.issues.length} issues) -- 0 entities`,
        );
      } else {
        for (const entity of parsed.data.dataModel.entities) {
          if ((entity.name ?? "").trim().length === 0) continue;
          collections.push(translateEntity(entity));
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notes.push(`spec-canvas.json read/parse failed: ${msg}`);
    }
  }

  // Ensure a users auth collection always exists -- conservative auth
  // posture comes for free from deriveDefaultApiRules(). If the spec
  // already defined one, leave it as-is.
  const hasUsers = collections.some((c) => c.name === "users");
  if (!hasUsers) {
    collections.unshift({
      name: "users",
      type: "auth",
      fields: [
        { name: "name", kind: "text", required: false, unique: false },
        { name: "avatar", kind: "file", required: false, unique: false },
      ],
      apiRules: deriveDefaultApiRules("users", false),
      indexes: [],
      softDelete: false,
    });
    notes.push("users auth collection synthesised (no users entity in spec)");
  }

  // Write derived-collections.json before applying so the review gate
  // surfaces a real artifact even when applySchema() throws.
  await ctx.fs.mkdir(getBackendDir(ctx.ventureRoot));
  const derivedCollectionsPath =
    `${getBackendDir(ctx.ventureRoot)}/derived-collections.json`;
  await ctx.fs.writeFile(
    derivedCollectionsPath,
    `${JSON.stringify(collections, null, 2)}\n`,
  );

  // Apply via the provider. config_only providers accept any input and
  // no-op; PocketBase writes one migration per collection + runs
  // `pocketbase migrate up`.
  await ctx.provider.applySchema({
    ventureRoot: ctx.ventureRoot,
    baseUrl: ctx.baseUrl,
    collections,
  });

  return {
    status: "done",
    collections,
    derivedCollectionsPath,
    collectionsApplied: collections.length,
    notes,
  };
}
