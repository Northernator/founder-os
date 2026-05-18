// Parse helpers for backend-core. Thin wrappers around the zod schemas so
// callers can use either `parse` (throw on invalid) or `safeParse`
// (returns a Result-shaped object) without rewriting the boilerplate.
//
// Mirrors the parseCrmConfig / safeParseCrmConfig convention in
// @founder-os/crm-core and parseMediaScript / safeParseMediaScript in
// @founder-os/media-core.

import {
  BackendCheckpointSchema,
  BackendConfigSchema,
  BackendExportSchema,
  BackendInstanceSchema,
  CollectionSchema,
  FieldSchema,
  SupabaseConfigSchema,
  type BackendCheckpoint,
  type BackendConfig,
  type BackendExport,
  type BackendInstance,
  type Collection,
  type Field,
  type SupabaseConfig,
} from "./index.js";

export function parseBackendConfig(input: unknown): BackendConfig {
  return BackendConfigSchema.parse(input);
}
export function safeParseBackendConfig(input: unknown) {
  return BackendConfigSchema.safeParse(input);
}

export function parseBackendInstance(input: unknown): BackendInstance {
  return BackendInstanceSchema.parse(input);
}
export function safeParseBackendInstance(input: unknown) {
  return BackendInstanceSchema.safeParse(input);
}

export function parseCollection(input: unknown): Collection {
  return CollectionSchema.parse(input);
}
export function safeParseCollection(input: unknown) {
  return CollectionSchema.safeParse(input);
}

export function parseField(input: unknown): Field {
  return FieldSchema.parse(input);
}
export function safeParseField(input: unknown) {
  return FieldSchema.safeParse(input);
}

export function parseBackendExport(input: unknown): BackendExport {
  return BackendExportSchema.parse(input);
}
export function safeParseBackendExport(input: unknown) {
  return BackendExportSchema.safeParse(input);
}

export function parseBackendCheckpoint(input: unknown): BackendCheckpoint {
  return BackendCheckpointSchema.parse(input);
}
export function safeParseBackendCheckpoint(input: unknown) {
  return BackendCheckpointSchema.safeParse(input);
}

// Supabase-config parse helpers (slice 2 of the Supabase arc).
// SupabaseConfig holds projectUrl + env-var NAMES; resolution of the
// actual key values happens via resolveSupabaseCredentials() in index.ts,
// which takes an env snapshot.
export function parseSupabaseConfig(input: unknown): SupabaseConfig {
  return SupabaseConfigSchema.parse(input);
}
export function safeParseSupabaseConfig(input: unknown) {
  return SupabaseConfigSchema.safeParse(input);
}
