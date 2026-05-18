/**
 * chatgpt-sub provider — tier_0, paste-in only.
 *
 * OpenAI exposes no programmatic access to ChatGPT Plus's Deep Research
 * feature (the API is a separate paid product). The realistic integration
 * is paste-in, identical to the `gemini_flow` tier_3 in the media arc.
 *
 * Flow:
 *   1. Orchestrator constructs this provider, calls researchTopic().
 *   2. Provider emits the paste-in prompt markdown via the RequestPasteIn
 *      callback the orchestrator supplied. That callback fires the
 *      review-gate UI ("Copy prompt & open ChatGPT").
 *   3. Founder runs Deep Research in chatgpt.com, pastes the response.
 *   4. RequestPasteIn resolves with { kind: "pasted", markdown }; provider
 *      parses it the same way the other channels' responses get parsed.
 *
 * If the founder skips ("not at desk right now"), we return an empty
 * ProviderPartial with every question marked unanswered, so the orchestrator
 * proceeds with the channels that responded — cross-reference still works
 * on 2 of 3.
 *
 * CLIENT-SAFE — pure, no node:*. The UI wires the actual paste-in callback.
 */

import {
  parsePastedDeepResearch,
  type ProviderPartial,
  type RequestPasteIn,
  type ResearchChannel,
  type ResearchProvider,
  type ResearchTopicOpts,
} from "@founder-os/research-deep-core";
import { buildPasteInPromptMarkdown } from "./prompts.js";

export interface CreateChatgptSubProviderOpts {
  /**
   * Callback that fires the review-gate UI and resolves once the founder
   * pastes the response (or explicitly skips). In Node-side tests the
   * caller stubs this with a recorded fixture; in the desktop app it's
   * wired to the Tauri command that drives the gate component.
   */
  requestPaste: RequestPasteIn;
  /**
   * Channel hint shown in the gate ("Paste this into ChatGPT…"). Override
   * for the generic `paste-in` provider, which reuses this same factory
   * under a different name.
   */
  channelHint?: string;
  /**
   * Channel tag stamped on sources + sections. Default: "chatgpt-sub".
   * The generic paste-in provider passes "paste-in" instead.
   */
  channelOverride?: ResearchChannel;
}

export class ChatgptSubSkippedError extends Error {
  constructor(reason?: string) {
    super(
      `chatgpt-sub: founder skipped the paste-in${reason ? ` (${reason})` : ""}`,
    );
    this.name = "ChatgptSubSkippedError";
  }
}

/**
 * Build a ChatGPT paste-in `ResearchProvider`. Always reports
 * `available()` true — paste-in is the never-fails channel. Skipped
 * paste-ins return an empty partial rather than throwing, so the
 * orchestrator can keep going with the other channels.
 */
export function createChatgptSubProvider(
  opts: CreateChatgptSubProviderOpts,
): ResearchProvider {
  const channel = opts.channelOverride ?? "chatgpt-sub";
  const channelHint = opts.channelHint ?? "ChatGPT (use Deep Research mode)";

  return {
    name: channel,

    async available(): Promise<boolean> {
      // Paste-in is always available — the founder either pastes or skips.
      // available() is for the orchestrator's channel-selection pass;
      // skipping happens later inside researchTopic().
      return true;
    },

    async researchTopic(topicOpts: ResearchTopicOpts): Promise<ProviderPartial> {
      const accessedAt = topicOpts.accessedAt ?? new Date().toISOString();
      const promptMarkdown = buildPasteInPromptMarkdown({
        topic: topicOpts.topic,
        questions: topicOpts.questions,
        ventureContext: topicOpts.ventureContext,
        accessedAt,
        channelHint,
      });

      const pasteResult = await opts.requestPaste({
        channel,
        topicSlug: topicOpts.topic.slug,
        topicLabel: topicOpts.topic.label,
        promptMarkdown,
      });

      if (pasteResult.kind === "skipped") {
        return {
          sections: [],
          sources: [],
          unanswered: topicOpts.questions.map((q) => q.question),
          rawTranscript: {
            channel,
            promptMarkdown,
            skipped: true,
            reason: pasteResult.reason,
          },
        };
      }

      const partial = parsePastedDeepResearch(pasteResult.markdown, {
        channel,
        accessedAt,
        expectedQuestions: topicOpts.questions.map((q) => q.question),
      });

      return {
        ...partial,
        rawTranscript: {
          channel,
          promptMarkdown,
          pastedMarkdown: pasteResult.markdown,
        },
      };
    },
  };
}
