import { desc, eq } from "drizzle-orm";
import type { FounderDb } from "../client";
import { runs } from "../schema";

export interface RunRow {
  runId: string;
  ventureId: string;
  type: string;
  status: string;
  summary?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export function createRun(
  db: FounderDb,
  input: { runId: string; ventureId: string; type: string }
): void {
  db.insert(runs)
    .values({
      runId: input.runId,
      ventureId: input.ventureId,
      type: input.type,
      status: "accepted",
      createdAt: new Date().toISOString(),
    })
    .run();
}

export function updateRunStatus(
  db: FounderDb,
  runId: string,
  status: string,
  opts: { summary?: string; error?: string; completedAt?: string } = {}
): void {
  db.update(runs)
    .set({
      status,
      summary: opts.summary ?? null,
      error: opts.error ?? null,
      completedAt: opts.completedAt ?? null,
    })
    .where(eq(runs.runId, runId))
    .run();
}

export function listRunsForVenture(db: FounderDb, ventureId: string): RunRow[] {
  return db
    .select()
    .from(runs)
    .where(eq(runs.ventureId, ventureId))
    .orderBy(desc(runs.createdAt))
    .all()
    .map((r) => ({
      runId: r.runId,
      ventureId: r.ventureId,
      type: r.type,
      status: r.status,
      summary: r.summary ?? undefined,
      error: r.error ?? undefined,
      createdAt: r.createdAt,
      completedAt: r.completedAt ?? undefined,
    }));
}
