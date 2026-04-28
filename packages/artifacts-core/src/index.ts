import { z } from "zod";

export const ArtifactTypeSchema = z.enum([
  "research-summary",
  "dev-brief",
  "product-spec",
  "naming-scan",
  "trademark-scan",
  "domain-scan",
  "social-scan",
  "brand-brief",
  "logo-pack",
  "brand-kit",
  "wireframe-pack",
  "stitch-prompt-pack",
  "stitch-export",
  "build-handoff",
  "code-wiki",
  "truth-layer",
  "audit-report",
  "red-team-report",
  "budget-model",
  "uk-setup-checklist",
]);
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export const ArtifactStatusSchema = z.enum(["pending", "ready", "failed", "stale"]);
export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>;

export const ArtifactSchema = z.object({
  artifactId: z.string(),
  ventureId: z.string(),
  type: ArtifactTypeSchema,
  path: z.string(),
  hash: z.string().optional(),
  status: ArtifactStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  derivedFrom: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export interface CreateArtifactInput {
  artifactId: string;
  ventureId: string;
  type: ArtifactType;
  path: string;
  hash?: string;
  status?: ArtifactStatus;
  derivedFrom?: string[];
  tags?: string[];
}

export function createArtifact(input: CreateArtifactInput): Artifact {
  const now = new Date().toISOString();
  return {
    artifactId: input.artifactId,
    ventureId: input.ventureId,
    type: input.type,
    path: input.path,
    hash: input.hash,
    status: input.status ?? "pending",
    createdAt: now,
    updatedAt: now,
    derivedFrom: input.derivedFrom ?? [],
    tags: input.tags ?? [],
  };
}

/**
 * Deterministic artifact id from venture + type + path.
 * Stable across runs so re-indexing doesn't create duplicates.
 */
export function computeArtifactId(ventureId: string, type: ArtifactType, path: string): string {
  // simple stable id; swap for hash if collisions ever matter
  return `${ventureId}:${type}:${path}`.replace(/[^a-zA-Z0-9:_\-./]/g, "_");
}
