// Parse helpers for handoff-pack-core. Thin wrappers around the zod schemas
// so callers can use either `parse` (throw on invalid) or `safeParse`
// (returns a Result-shaped object) without rewriting the boilerplate.
//
// Mirrors the parseBackendConfig / safeParseBackendConfig convention in
// @founder-os/backend-core and parseCrmConfig / safeParseCrmConfig in
// @founder-os/crm-core.

import {
  BrandTokensSchema,
  DocDescriptorSchema,
  HandoffPackCheckpointSchema,
  HandoffPackConfigSchema,
  HandoffPackInventorySchema,
  PdfTemplateConfigSchema,
  RolePackDescriptorSchema,
  type BrandTokens,
  type DocDescriptor,
  type HandoffPackCheckpoint,
  type HandoffPackConfig,
  type HandoffPackInventory,
  type PdfTemplateConfig,
  type RolePackDescriptor,
} from "./index.js";

export function parseDocDescriptor(input: unknown): DocDescriptor {
  return DocDescriptorSchema.parse(input);
}
export function safeParseDocDescriptor(input: unknown) {
  return DocDescriptorSchema.safeParse(input);
}

export function parseBrandTokens(input: unknown): BrandTokens {
  return BrandTokensSchema.parse(input);
}
export function safeParseBrandTokens(input: unknown) {
  return BrandTokensSchema.safeParse(input);
}

export function parsePdfTemplateConfig(input: unknown): PdfTemplateConfig {
  return PdfTemplateConfigSchema.parse(input);
}
export function safeParsePdfTemplateConfig(input: unknown) {
  return PdfTemplateConfigSchema.safeParse(input);
}

export function parseRolePackDescriptor(input: unknown): RolePackDescriptor {
  return RolePackDescriptorSchema.parse(input);
}
export function safeParseRolePackDescriptor(input: unknown) {
  return RolePackDescriptorSchema.safeParse(input);
}

export function parseHandoffPackInventory(
  input: unknown
): HandoffPackInventory {
  return HandoffPackInventorySchema.parse(input);
}
export function safeParseHandoffPackInventory(input: unknown) {
  return HandoffPackInventorySchema.safeParse(input);
}

export function parseHandoffPackCheckpoint(
  input: unknown
): HandoffPackCheckpoint {
  return HandoffPackCheckpointSchema.parse(input);
}
export function safeParseHandoffPackCheckpoint(input: unknown) {
  return HandoffPackCheckpointSchema.safeParse(input);
}

export function parseHandoffPackConfig(input: unknown): HandoffPackConfig {
  return HandoffPackConfigSchema.parse(input);
}
export function safeParseHandoffPackConfig(input: unknown) {
  return HandoffPackConfigSchema.safeParse(input);
}
