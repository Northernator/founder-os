/**
 * Workers — fan out one topic across 2-3 ResearchProvider instances in
 * parallel and collect their partials. Each provider has already been
 * built by the host (with its CallLlm / spawn / fetch / paste-in
 * callback injected); this module just calls researchTopic() on each.
 *
 * Uses Promise.allSettled — one channel timing out / throwing must NOT
 * sink the others. We surface a Map<channel, success | failure> so the
 * cross-referencer and synthesiser can decide how to handle partial
 * coverage.
 *
 * Availability is probed up-front so a definitively unavailable channel
 * (gemini-cli missing) does not even attempt a call. Providers that throw
 * inside available() are treated as unavailable rather than fatal.
 */

import type {
  ProviderPartial,
  ResearchChannel,
  ResearchProvider,
  ResearchQuestion,
} from "@founder-os/research-deep-core";

export interface WorkerInput {
  topic: { slug: string; label: string };
  questions: ResearchQuestion[];
  ventureContext: string;
  accessedAt: string;
  signal?: AbortSignal;
}

export interface WorkerSuccess {
  kind: "success";
  channel: ResearchChannel;
  partial: ProviderPartial;
}

export interface WorkerFailure {
  kind: "failure";
  channel: ResearchChannel;
  reason: "unavailable" | "errored";
  error?: unknown;
}

export type WorkerOutcome = WorkerSuccess | WorkerFailure;

export interface RunParallelWorkersResult {
  /** All outcomes (success + failure), in the same order as the input providers. */
  outcomes: WorkerOutcome[];
  /** Convenience: successful partials keyed by channel. */
  successes: Map<ResearchChannel, ProviderPartial>;
  /** Convenience: failure reasons keyed by channel. */
  failures: Map<ResearchChannel, WorkerFailure>;
}

/**
 * Run every provider against the same topic in parallel. Returns ALL
 * outcomes — including failures — so the caller can decide whether the
 * remaining successes are enough to proceed (1+) or whether to bail
 * (0 successes => AllWorkersFailedError, raised by the orchestrator).
 *
 * Each provider's `available()` is probed first; an unavailable channel
 * is recorded as a failure with reason "unavailable" but is not invoked.
 * This matters because some providers (paste-in, gemini-sub) have side
 * effects on call.
 */
export async function runParallelWorkers(
  providers: ReadonlyArray<ResearchProvider>,
  input: WorkerInput,
): Promise<RunParallelWorkersResult> {
  const tasks = providers.map(async (provider): Promise<WorkerOutcome> => {
    let available: boolean;
    try {
      available = await provider.available();
    } catch (err) {
      return {
        kind: "failure",
        channel: provider.name,
        reason: "unavailable",
        error: err,
      };
    }
    if (!available) {
      return {
        kind: "failure",
        channel: provider.name,
        reason: "unavailable",
      };
    }
    try {
      const partial = await provider.researchTopic({
        topic: input.topic,
        questions: input.questions,
        ventureContext: input.ventureContext,
        accessedAt: input.accessedAt,
        signal: input.signal,
      });
      return { kind: "success", channel: provider.name, partial };
    } catch (err) {
      return {
        kind: "failure",
        channel: provider.name,
        reason: "errored",
        error: err,
      };
    }
  });

  const outcomes = await Promise.all(tasks);

  const successes = new Map<ResearchChannel, ProviderPartial>();
  const failures = new Map<ResearchChannel, WorkerFailure>();
  for (const outcome of outcomes) {
    if (outcome.kind === "success") {
      successes.set(outcome.channel, outcome.partial);
    } else {
      failures.set(outcome.channel, outcome);
    }
  }

  return { outcomes, successes, failures };
}
