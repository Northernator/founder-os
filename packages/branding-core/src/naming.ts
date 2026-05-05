import { z } from "zod";

export const NamingStyleSchema = z.enum([
  "compound", // two words fused: "Dropbox", "Shopify"
  "invented", // pure invention: "Figma", "Canva"
  "descriptive", // what it does: "Basecamp"
  "acronym", // "JIRA", "SaaS"
  "personal", // founder name: "Tesla"
  "metaphor", // "Slack", "Stripe"
]);
export type NamingStyle = z.infer<typeof NamingStyleSchema>;

export const NameCandidateSchema = z.object({
  name: z.string(),
  style: NamingStyleSchema,
  rationale: z.string(),
  domainAvailabilityHint: z.enum(["likely", "unlikely", "unknown"]).default("unknown"),
  trademarkRiskHint: z.enum(["low", "medium", "high", "unknown"]).default("unknown"),
});
export type NameCandidate = z.infer<typeof NameCandidateSchema>;

export const NamingReportSchema = z.object({
  ventureId: z.string(),
  industry: z.string(),
  candidates: z.array(NameCandidateSchema),
  recommended: z.string().describe("The recommended name from candidates"),
  rationale: z.string(),
  createdAt: z.string(),
});
export type NamingReport = z.infer<typeof NamingReportSchema>;

export function createNamingReport(opts: Omit<NamingReport, "createdAt">): NamingReport {
  return NamingReportSchema.parse({
    ...opts,
    createdAt: new Date().toISOString(),
  });
}

/** Generate default naming candidates from a set of seed words */
export function generateSeedCandidates(seeds: string[], industry: string): NameCandidate[] {
  // Simple deterministic generation for seeding — AI fills in the real names
  return [
    {
      name: seeds.slice(0, 2).join("").toLowerCase(),
      style: "compound",
      rationale: `Compound of seed words: ${seeds.slice(0, 2).join(" + ")}`,
      domainAvailabilityHint: "unknown",
      trademarkRiskHint: "unknown",
    },
    {
      name: `${seeds[0]?.toLowerCase()}ly`,
      style: "invented",
      rationale: `"${seeds[0]}" with invented suffix for SaaS feel`,
      domainAvailabilityHint: "unknown",
      trademarkRiskHint: "unknown",
    },
    {
      name: `${seeds[0]?.toLowerCase()}hq`,
      style: "descriptive",
      rationale: `"${seeds[0]}" + HQ — signals ${industry} hub`,
      domainAvailabilityHint: "likely",
      trademarkRiskHint: "low",
    },
  ].filter((c) => c.name && c.name.length > 2) as NameCandidate[];
}
