import type { AuditFinding } from "@founder-os/audit-contract";
import { eq } from "drizzle-orm";
import type { FounderDb } from "../client";
import { auditFindings } from "../schema";

export function insertAuditFindings(
  db: FounderDb,
  input: { runId: string; ventureId: string; findings: AuditFinding[] }
): void {
  if (input.findings.length === 0) return;
  const now = new Date().toISOString();
  const values = input.findings.map((f, i) => ({
    id: `${input.runId}-${i}`,
    runId: input.runId,
    ventureId: input.ventureId,
    ruleId: f.ruleId,
    severity: f.severity,
    title: f.title,
    message: f.message,
    filePath: f.evidence[0]?.filePath ?? null,
    createdAt: now,
  }));
  db.insert(auditFindings).values(values).run();
}

export function listFindingsForRun(db: FounderDb, runId: string) {
  return db.select().from(auditFindings).where(eq(auditFindings.runId, runId)).all();
}
