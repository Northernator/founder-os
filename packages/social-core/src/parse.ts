// Parse helpers for social-core. Thin wrappers around the zod schemas so
// callers can use either `parse` (throw on invalid) or `safeParse`
// (returns a Result-shaped object) without rewriting the boilerplate.
//
// Mirrors the parseBackendConfig / safeParseBackendConfig convention in
// @founder-os/backend-core and parseCrmConfig / safeParseCrmConfig in
// @founder-os/crm-core.

import {
  PostizConfigSchema,
  SocialConfigSchema,
  SocialMediaRefSchema,
  SocialPostSchema,
  SocialPosterConfigSchema,
  SocialResultSchema,
  type PostizConfig,
  type SocialConfig,
  type SocialMediaRef,
  type SocialPost,
  type SocialPosterConfig,
  type SocialResult,
} from "./index.js";

export function parseSocialConfig(input: unknown): SocialConfig {
  return SocialConfigSchema.parse(input);
}
export function safeParseSocialConfig(input: unknown) {
  return SocialConfigSchema.safeParse(input);
}

export function parseSocialPost(input: unknown): SocialPost {
  return SocialPostSchema.parse(input);
}
export function safeParseSocialPost(input: unknown) {
  return SocialPostSchema.safeParse(input);
}

export function parseSocialResult(input: unknown): SocialResult {
  return SocialResultSchema.parse(input);
}
export function safeParseSocialResult(input: unknown) {
  return SocialResultSchema.safeParse(input);
}

export function parseSocialMediaRef(input: unknown): SocialMediaRef {
  return SocialMediaRefSchema.parse(input);
}
export function safeParseSocialMediaRef(input: unknown) {
  return SocialMediaRefSchema.safeParse(input);
}

export function parsePostizConfig(input: unknown): PostizConfig {
  return PostizConfigSchema.parse(input);
}
export function safeParsePostizConfig(input: unknown) {
  return PostizConfigSchema.safeParse(input);
}

export function parseSocialPosterConfig(
  input: unknown
): SocialPosterConfig {
  return SocialPosterConfigSchema.parse(input);
}
export function safeParseSocialPosterConfig(input: unknown) {
  return SocialPosterConfigSchema.safeParse(input);
}
