import { eq } from "drizzle-orm";
import type { Venture, VentureStage } from "@founder-os/domain";
import type { FounderDb } from "../client";
import { ventures } from "../schema";

export interface VentureRow extends Venture {}

function rowToVenture(row: typeof ventures.$inferSelect): VentureRow {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    stage: row.stage as VentureStage,
    rootPath: row.rootPath,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function upsertVenture(db: FounderDb, v: VentureRow): void {
  db.insert(ventures)
    .values({
      id: v.id,
      name: v.name,
      slug: v.slug,
      stage: v.stage,
      rootPath: v.rootPath,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    })
    .onConflictDoUpdate({
      target: ventures.id,
      set: {
        name: v.name,
        slug: v.slug,
        stage: v.stage,
        rootPath: v.rootPath,
        updatedAt: v.updatedAt,
      },
    })
    .run();
}

export function getVenture(db: FounderDb, id: string): VentureRow | undefined {
  const row = db.select().from(ventures).where(eq(ventures.id, id)).get();
  return row ? rowToVenture(row) : undefined;
}

export function getVentureBySlug(db: FounderDb, slug: string): VentureRow | undefined {
  const row = db.select().from(ventures).where(eq(ventures.slug, slug)).get();
  return row ? rowToVenture(row) : undefined;
}

export function listVentures(db: FounderDb): VentureRow[] {
  return db
    .select()
    .from(ventures)
    .all()
    .map(rowToVenture);
}

export function updateStage(db: FounderDb, id: string, stage: VentureStage): void {
  db.update(ventures)
    .set({ stage, updatedAt: new Date().toISOString() })
    .where(eq(ventures.id, id))
    .run();
}
