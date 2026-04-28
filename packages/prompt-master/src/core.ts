import { getCached, putCached } from "./cache.js";
import { getTransport } from "./client.js";
import { estimateTokens, hashKey } from "./hash.js";
import { emit } from "./telemetry.js";
/**
 * Core optimize() dispatcher.
 *
 * The single function every surface calls. Handles cache lookup, transport
 * dispatch, fallback, telemetry, and shape normalisation.
 *
 * Flow:
 *   1. Compute hash (or use override) for cache key
 *   2. Look up cache → on hit, return cached + emit telemetry
 *   3. Call transport with the prompt
 *   4. On success: store in cache, emit telemetry, return optimized
 *   5. On any transport error: emit fallback telemetry, return input unchanged
 *
 * Optimization NEVER throws. The system must keep working when Prompt Master
 * is unreachable. That guarantee is what makes it safe to wire into every
 * call site without defensive try/catch at every site.
 */
import type { OptimizeInput, OptimizeResult, PromptContext } from "./types.js";

export async function optimize(input: OptimizeInput): Promise<OptimizeResult> {
  const start = Date.now();
  const context: PromptContext = input.context ?? "other";
  const ventureId = input.ventureId;
  const hash =
    input.cacheKey ??
    (await hashKey({
      prompt: input.prompt,
      model: input.model,
      maxLossBudget: input.maxLossBudget,
    }));

  // 1. Cache lookup
  const cached = await getCached(hash);
  if (cached) {
    const tokensSaved = estimateTokens(input.prompt) - estimateTokens(cached.optimized);
    const result: OptimizeResult = {
      optimized: cached.optimized,
      tokensSaved: Math.max(0, tokensSaved),
      cacheHit: true,
      fallbackUsed: false,
      trace: { hash, latencyMs: Date.now() - start, transport: "cache" },
    };
    await emit({
      event: "prompt_master.optimize",
      context,
      tokensSaved: result.tokensSaved,
      cacheHit: true,
      latencyMs: result.trace.latencyMs,
      transport: "cache",
      ventureId,
    });
    return result;
  }

  // 2. Transport dispatch
  const transport = getTransport();
  try {
    const { optimized } = await transport.optimize(input);
    const tokensSaved = Math.max(0, estimateTokens(input.prompt) - estimateTokens(optimized));

    // Cache only if the transport actually did something. Caching the null
    // transport's pass-through would pollute the cache with non-optimized
    // entries that hide future real optimizations behind a stale hit.
    const isPassthrough = transport.name === "null" || optimized === input.prompt;
    if (!isPassthrough) {
      await putCached(hash, optimized);
    }

    const result: OptimizeResult = {
      optimized,
      tokensSaved,
      cacheHit: false,
      fallbackUsed: isPassthrough,
      trace: { hash, latencyMs: Date.now() - start, transport: transport.name },
    };

    if (isPassthrough) {
      await emit({
        event: "prompt_master.fallback",
        context,
        reason:
          transport.name === "null"
            ? "no transport configured"
            : "transport returned input unchanged",
        ventureId,
      });
    } else {
      await emit({
        event: "prompt_master.optimize",
        context,
        tokensSaved,
        cacheHit: false,
        latencyMs: result.trace.latencyMs,
        transport: transport.name,
        ventureId,
      });
    }
    return result;
  } catch (err) {
    // 3. Transport error → fallback. Do not throw.
    await emit({
      event: "prompt_master.fallback",
      context,
      reason: `transport error: ${(err as Error).message ?? String(err)}`,
      ventureId,
    });
    return {
      optimized: input.prompt,
      tokensSaved: 0,
      cacheHit: false,
      fallbackUsed: true,
      trace: { hash, latencyMs: Date.now() - start, transport: transport.name },
    };
  }
}
