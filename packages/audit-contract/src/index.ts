import { z } from "zod";

export const AuditSeveritySchema = z.enum(["low", "medium", "high", "critical"]);
export type AuditSeverity = z.infer<typeof AuditSeveritySchema>;

export const FileEvidenceSchema = z.object({
  filePath: z.string(),
  startLine: z.number().optional(),
  endLine: z.number().optional(),
  snippet: z.string().optional(),
});
export type FileEvidence = z.infer<typeof FileEvidenceSchema>;

export const SuggestedFixSchema = z.object({
  description: z.string(),
  patch: z.string().optional(),
});
export type SuggestedFix = z.infer<typeof SuggestedFixSchema>;

export const AuditFindingSchema = z.object({
  ruleId: z.string(),
  severity: AuditSeveritySchema,
  title: z.string(),
  message: z.string(),
  evidence: z.array(FileEvidenceSchema).default([]),
  suggestedFix: SuggestedFixSchema.optional(),
});
export type AuditFinding = z.infer<typeof AuditFindingSchema>;

export const AuditSummarySchema = z.object({
  runId: z.string(),
  ventureId: z.string(),
  passed: z.boolean(),
  findings: z.array(AuditFindingSchema),
  counts: z.object({
    low: z.number(),
    medium: z.number(),
    high: z.number(),
    critical: z.number(),
  }),
  createdAt: z.string(),
});
export type AuditSummary = z.infer<typeof AuditSummarySchema>;

export function countBySeverity(findings: AuditFinding[]) {
  const counts = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

export function auditPassed(findings: AuditFinding[]): boolean {
  return !findings.some((f) => f.severity === "high" || f.severity === "critical");
}
