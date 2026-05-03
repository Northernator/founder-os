/**
 * CompetitiveIntelAgent -- maps the competitive landscape.
 *
 * Reads research slice; returns top 3 competitors with our (claimed)
 * advantage vs each, prospect's likely pain points, and concrete
 * opportunities for our solution.
 *
 * "Our solution" is intentionally generic -- this agent does not know
 * about our product. It produces market-position analysis that the
 * outreach agent then specialises against our pitch.
 */

import { BaseAgent } from "../agent-base.js";
import type { AgentInput, CompetitiveIntelSlice } from "../types.js";

const SYSTEM_PROMPT = `You are a competitive intelligence analyst. Analyse the
prospect's market position. Identify:
 - competitors: top 3 likely competitors and what differentiates each
 - painPoints: what likely keeps the prospect's leadership up at night
 - opportunity: where a new entrant could realistically slot in

Return ONLY valid JSON:
{ "competitors": [ { "name": ..., "advantage": ... }, ... ],
  "painPoints": [ ... ],
  "opportunity": "..." }`;

export class CompetitiveIntelAgent extends BaseAgent {
  readonly name = "CompetitiveIntelAgent";

  protected async execute(input: AgentInput): Promise<Record<string, unknown>> {
    const memory = await this.loadMemory(input.fs, input.memoryPath);
    const research = memory.research?.company ?? {};

    const userPrompt =
      `Analyse the competitive landscape for this company:\n\n` +
      `${JSON.stringify(research, null, 2)}\n\n` +
      `Be specific about real competitors where you can name them. Avoid ` +
      `generic platitudes like "established players in the space".`;

    const parsed = await this.callJson<{
      competitors: CompetitiveIntelSlice["competitors"];
      painPoints?: string[];
      opportunity?: string;
    }>(input.callLlm, SYSTEM_PROMPT, userPrompt);

    const slice: CompetitiveIntelSlice = {
      competitors: parsed.competitors ?? [],
      painPoints: parsed.painPoints,
      opportunity: parsed.opportunity,
      timestamp: new Date().toISOString(),
    };

    return slice as unknown as Record<string, unknown>;
  }
}
