/**
 * DecisionMakerFinderAgent -- identifies likely decision makers.
 *
 * Reads research slice from memory, returns 3-5 contact roles with
 * department + finding tips (LinkedIn search hints, conference circuits,
 * etc). No PII guessing -- this is role-level, not person-level.
 */

import { BaseAgent } from "../agent-base.js";
import type { AgentInput, DecisionMakersSlice } from "../types.js";

const SYSTEM_PROMPT = `You are an expert at identifying high-value contacts at
B2B companies. Given company info, identify 3-5 likely decision-maker ROLES
(not specific named people). For each role include:
 - title: the role title (e.g. "VP of Engineering")
 - department: which department they sit in
 - location: where in the org chart (executive / mid-management / IC lead)
 - findingTips: how a sales rep could find this person (LinkedIn search query,
   typical conferences, common job-board listings, etc)

Return ONLY valid JSON:
{ "contacts": [ { "title": ..., "department": ..., "location": ...,
  "findingTips": ... }, ... ] }

Do NOT invent specific names or contact info -- role + finding tips only.`;

export class DecisionMakerFinderAgent extends BaseAgent {
  readonly name = "DecisionMakerFinderAgent";

  protected async execute(input: AgentInput): Promise<Record<string, unknown>> {
    const memory = await this.loadMemory(input.fs, input.memoryPath);
    const research = memory.research?.company ?? {};

    const userPrompt =
      `Find likely decision makers at this company:\n\n` +
      `${JSON.stringify(research, null, 2)}\n\n` +
      `List 3-5 ROLES (not named people). Include department, seniority, and ` +
      `concrete finding tips.`;

    const parsed = await this.callJson<{ contacts: DecisionMakersSlice["contacts"] }>(
      input.callLlm,
      SYSTEM_PROMPT,
      userPrompt,
    );

    const slice: DecisionMakersSlice = {
      contacts: parsed.contacts ?? [],
      timestamp: new Date().toISOString(),
    };

    return slice as unknown as Record<string, unknown>;
  }
}
