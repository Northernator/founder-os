import type { Artifact, ArtifactType } from "@founder-os/artifacts-core";
import { and, eq } from "drizzle-orm";
import type { FounderDb } from "../client";
import { artifacts } from "../schema";

function rowToArtifact(row: typeof artifacts.$inferSelect): Artifact {
  return {
    artifactId: row.artifactId,
    ventureId: row.ventureId,
    type: row.type as ArtifactType,
    path: row.path,
    hash: row.hash ?? undefined,
    status: row.status as Artifact["status"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    derivedFrom: JSON.parse(row.derivedFromJson) as string[],
    tags: JSON.parse(row.tagsJson) as string[],
  };
}

export function upsertArtifact(db: FounderDb, a: Artifact): void {
  db.insert(artifacts)
    .values({
      artifactId: a.artifactId,
      ventureId: a.ventureId,
      type: a.type,
      path: a.path,
      hash: a.hash ?? null,
      status: a.status,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      derivedFromJson: JSON.stringify(a.derivedFrom ?? []),
      tagsJson: JSON.stringify(a.tags ?? []),
    })
    .onConflictDoUpdate({
      target: artifacts.artifactId,
      set: {
        type: a.type,
        path: a.path,
        hash: a.hash ?? null,
        status: a.status,
        updatedAt: a.updatedAt,
        derivedFromJson: JSON.stringify(a.derivedFrom ?? []),
        tagsJson: JSON.stringify(a.tags ?? []),
      },
    })
    .run();
}

export function listArtifactsForVenture(db: FounderDb, ventureId: string): Artifact[] {
  return db
    .select()
    .from(artifacts)
    .where(eq(artifacts.ventureId, ventureId))
    .all()
    .map(rowToArtifact);
}

export function getArtifactsByType(
  db: FounderDb,
  ventureId: string,
  type: ArtifactType
): Artifact[] {
  return db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.ventureId, ventureId), eq(artifacts.type, type)))
    .all()
    .map(rowToArtifact);
}

export function hasArtifactOfType(db: FounderDb, ventureId: string, type: ArtifactType): boolean {
  return getArtifactsByType(db, ventureId, type).length > 0;
}
