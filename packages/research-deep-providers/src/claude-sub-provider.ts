/**
 * claude-sub provider — tier_0, the preferred worker + canonical synthesiser.
 *
 * Consumes an injected `CallLlm` (same contract as @founder-os/sales-agents
 * and the pipeline-runner's SaasLlmCaller). The host wires whichever
 * transport (claude-cli with subscription auth in Node, fetch-based with an
 * API key in the WebView), the provider is agnostic.
 *
 * Why "sub": when the host injects a CLI-backed CallLlm, the Claude CLI uses
 * whatever auth `claude login` set up — usually the founder's subscription.
 * The same provider object is fine on the API fallback transport — see
 * `claude-api` in slice 3, which is just a different `CallLlm` injected at
 * construction time.
 *
 * This file is CLIENT-SAFE — pure, no node:* imports — because the
 * Tauri WebView constructs the provider for type checking even though the
 * actual CallLlm injection happens in Node. Mirrors the prompt-master
 * client/Node split.
 */

import {
  parsePastedDeepResearch,
  type CallLlm,
  type ProviderPartial,
  type ResearchProvider,
  type ResearchTopicOpts,
} from "@founder-os/research-deep-core";
import {
  RESEARCH_WORKER_SYSTEM_PROMPT,
  buildWorkerUserPrompt,
} from "./prompts.js";

export interface CreateClaudeSubProviderOpts {
  /**
   * LLM caller. Subscription-preferred transport in Node is the Claude CLI
   * spawned via @founder-os/sales-agents' createClaudeCliCallLlm or the
   * prompt-master createClaudeCliTransport.
   */
  callLlm: CallLlm;
  /**
   * Probe that returns true when the underlying transport is reachable.
   * Defaults to "always true" (callers usually do their own pre-flight in
   * the bridge). Pass a real probe (e.g. `isClaudeCliAvailable`) to get
   * sensible behaviour from the orchestrator's channel-selection step.
   */
  isAvailable?: () => Promise<boolean>;
  /**
   * Override the channel tag — useful when reusing this provider for the
   * `claude-api` fallback. Default: "claude-sub".
   */
  channelOverride?: "claude-sub" | "claude-api";
}

export class ClaudeSubInvocationError extends Error {
  constructor(cause: string) {
    super(`claude-sub: ${cause}`);
    this.name = "ClaudeSubInvocationError";
  }
}

/**
 * Build a Claude subscription-channel `ResearchProvider`. Sends the topic
 * to the injected CallLlm with our shared worker prompt; parses the
 * markdown response into a `ProviderPartial` via the same paste-in parser
 * the other channels use.
 */
export function createClaudeSubProvider(
  opts: CreateClaudeSubProviderOpts,
): ResearchProvider {
  const channel = opts.channelOverride ?? "claude-sub";
  const isAvailable = opts.isAvailable ?? (async () => true);

  return {
    name: channel,

    async available(): Promise<boolean> {
      try {
        return await isAvailable();
      } catch {
        return false;
      }
    },

    async researchTopic(topicOpts: ResearchTopicOpts): Promise<ProviderPartial> {
      const accessedAt = topicOpts.accessedAt ?? new Date().toISOString();
      const userPrompt = buildWorkerUserPrompt({
        topic: topicOpts.topic,
        questions: topicOpts.questions,
        ventureContext: topicOpts.ventureContext,
        accessedAt,
      });

      let response: string;
      try {
        response = await opts.callLlm({
          system: RESEARCH_WORKER_SYSTEM_PROMPT,
          user: userPrompt,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ClaudeSubInvocationError(msg);
      }

      if (!response || !response.trim()) {
        throw new ClaudeSubInvocationError("empty response from callLlm");
      }

      const partial = parsePastedDeepResearch(response, {
        channel,
        accessedAt,
        expectedQuestions: topicOpts.questions.map((q) => q.question),
      });

      // Replace the paste-in shaped rawTranscript with a richer one — the
      // synthesiser wants the system/user pair too for the audit trail.
      return {
        ...partial,
        rawTranscript: {
          channel,
          system: RESEARCH_WORKER_SYSTEM_PROMPT,
          user: userPrompt,
          response,
        },
      };
    },
  };
}
