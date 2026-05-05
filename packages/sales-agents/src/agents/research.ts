/**
 * ResearchAgent -- the entry agent of the sales pipeline.
 *
 * Runs first and alone. The other three intel agents (BANT, decision
 * makers, competitive intel) all consume the research slice from memory
 * once SalesPipeline has merged this output. Sequencing is enforced by
 * SalesPipeline -- agents are still composable in isolation if a caller
 * wants partial runs.
 *
 * Returns the research slice in AgentOutput.data; pipeline writes it.
 */

import { BaseAgent } from "../agent-base.js";
import type { AgentInput, ResearchSlice } from "../types.js";

const SYSTEM_PROMPT = `You are a B2B sales researcher. Given a company website,
extract structured intelligence:
 - name, industry, employees (rough size band), founded (year), location
 - products: short list of core products / services
 - differentiators: what sets them apart in the market
 - recentNews: any visible funding / launches / leadership change

Return ONLY valid JSON in this shape:
{ "company": { "name": ..., "industry": ..., "employees": ..., "founded": ...,
  "location": ..., "products": ..., "differentiators": ..., "recentNews": ... } }

Use null for fields you cannot infer. Do not invent facts.`;

export class ResearchAgent extends BaseAgent {
  readonly name = "ResearchAgent";

  protected async execute(input: AgentInput): Promise<Record<string, unknown>> {
    const userPrompt = `Research this company website and provide structured intelligence:\n${input.prospectUrl}\n\nFocus on: who they are, what they do, market position, growth indicators.`;

    const parsed = await this.callJson<{ company: ResearchSlice["company"] }>(
      input.callLlm,
      SYSTEM_PROMPT,
      userPrompt
    );

    const slice: ResearchSlice = {
      company: parsed.company ?? {},
      timestamp: new Date().toISOString(),
    };

    return slice as unknown as Record<string, unknown>;
  }
}
