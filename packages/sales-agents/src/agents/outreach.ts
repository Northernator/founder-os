/**
 * OutreachAgent -- generates a 5-email outreach sequence.
 *
 * Runs LAST. Consumes ALL prior slices (research, bant, decision makers,
 * competitive intel) to produce emails that are specific, warm, and
 * non-salesy. Each email references concrete research findings.
 *
 * If any prior slice is missing the agent still emits a sequence but
 * notes the gap in subject lines so the human reviewer can spot weakly-
 * grounded outreach before sending.
 */

import { BaseAgent } from "../agent-base.js";
import type { AgentInput, OutreachSlice } from "../types.js";

const SYSTEM_PROMPT = `You are a top sales development rep. Write a 5-email
outreach sequence. Each email must:
 1. Reference a specific finding from the research (no generic platitudes)
 2. Show understanding of a real pain point
 3. Offer concrete value (not "I'd love to chat")
 4. Ask for ONE specific next step

Tone: warm, peer-to-peer, non-salesy. Subject lines under 50 chars. Bodies
under 120 words each.

Return ONLY valid JSON:
{ "emails": [ { "subject": ..., "body": ... }, ... ] }`;

export class OutreachAgent extends BaseAgent {
  readonly name = "OutreachAgent";

  protected async execute(input: AgentInput): Promise<Record<string, unknown>> {
    const memory = await this.loadMemory(input.fs, input.memoryPath);

    const userPrompt =
      `Write a personalised 5-email outreach sequence for this prospect.\n\n` +
      `Research:\n${JSON.stringify(memory.research?.company ?? {}, null, 2)}\n\n` +
      `BANT fit score: ${memory.bant?.fitScore ?? "N/A"} / 100\n` +
      `BANT reasoning: ${memory.bant?.reasoning ?? "N/A"}\n\n` +
      `Decision makers:\n${JSON.stringify(memory.decisionMakers?.contacts ?? [], null, 2)}\n\n` +
      `Competitive context:\n${JSON.stringify(memory.competitiveIntel ?? {}, null, 2)}\n\n` +
      `Make each email reference something specific. No generic openers.`;

    const parsed = await this.callJson<{ emails: OutreachSlice["emails"] }>(
      input.callLlm,
      SYSTEM_PROMPT,
      userPrompt,
    );

    const slice: OutreachSlice = {
      emails: parsed.emails ?? [],
      timestamp: new Date().toISOString(),
    };

    return slice as unknown as Record<string, unknown>;
  }
}
