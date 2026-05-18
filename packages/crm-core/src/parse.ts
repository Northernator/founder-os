// Parse helpers for crm-core. Thin wrappers around the zod schemas so
// callers can use either `parse` (throw on invalid) or `safeParse`
// (returns a Result-shaped object) without rewriting the boilerplate.
//
// Mirrors the parseMediaScript / safeParseMediaScript convention in
// @founder-os/media-core.

import {
  CrmCampaignSchema,
  CrmCheckpointSchema,
  CrmConfigSchema,
  CrmContactSchema,
  CrmInstanceSchema,
  CrmOpportunitySchema,
  CrmSegmentSchema,
  type CrmCampaign,
  type CrmCheckpoint,
  type CrmConfig,
  type CrmContact,
  type CrmInstance,
  type CrmOpportunity,
  type CrmSegment,
} from "./index.js";

export function parseCrmConfig(input: unknown): CrmConfig {
  return CrmConfigSchema.parse(input);
}
export function safeParseCrmConfig(input: unknown) {
  return CrmConfigSchema.safeParse(input);
}

export function parseCrmInstance(input: unknown): CrmInstance {
  return CrmInstanceSchema.parse(input);
}
export function safeParseCrmInstance(input: unknown) {
  return CrmInstanceSchema.safeParse(input);
}

export function parseCrmSegment(input: unknown): CrmSegment {
  return CrmSegmentSchema.parse(input);
}
export function safeParseCrmSegment(input: unknown) {
  return CrmSegmentSchema.safeParse(input);
}

export function parseCrmContact(input: unknown): CrmContact {
  return CrmContactSchema.parse(input);
}
export function safeParseCrmContact(input: unknown) {
  return CrmContactSchema.safeParse(input);
}

export function parseCrmOpportunity(input: unknown): CrmOpportunity {
  return CrmOpportunitySchema.parse(input);
}
export function safeParseCrmOpportunity(input: unknown) {
  return CrmOpportunitySchema.safeParse(input);
}

export function parseCrmCampaign(input: unknown): CrmCampaign {
  return CrmCampaignSchema.parse(input);
}
export function safeParseCrmCampaign(input: unknown) {
  return CrmCampaignSchema.safeParse(input);
}

export function parseCrmCheckpoint(input: unknown): CrmCheckpoint {
  return CrmCheckpointSchema.parse(input);
}
export function safeParseCrmCheckpoint(input: unknown) {
  return CrmCheckpointSchema.safeParse(input);
}
