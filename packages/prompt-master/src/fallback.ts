/**
 * Null transport — returns input unchanged.
 *
 * Used when no real Prompt Master transport has been registered. Optimization
 * is an enhancement, not a dependency: the system must keep working when the
 * upstream skill is unreachable, the API key is missing, or the user simply
 * hasn't wired in a transport yet.
 *
 * Behaviour: returns the input prompt unchanged with `fallbackUsed: true` set
 * by the core dispatcher. Telemetry records this as `prompt_master.fallback`
 * so dashboards can show coverage gaps.
 */
import type { OptimizeInput, PromptMasterTransport } from "./types.js";

export const NULL_TRANSPORT: PromptMasterTransport = {
  name: "null",
  async optimize(input: OptimizeInput) {
    return { optimized: input.prompt };
  },
};
