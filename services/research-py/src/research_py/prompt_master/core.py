"""
Core optimize() dispatcher. Mirrors src/core.ts.

Single async function every research-py site calls. Handles cache lookup,
transport dispatch, fallback, telemetry. NEVER throws — when Prompt Master
is unreachable, it returns the input prompt unchanged so callers can wrap
their LLM calls without defensive try/except at every site.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Optional, TypedDict

from .cache import get_cached, put_cached
from .client import get_transport
from .hash import estimate_tokens, hash_key
from .telemetry import emit


@dataclass
class OptimizeInput:
    prompt: str
    context: str = "other"
    model: Optional[str] = None
    max_loss_budget: float = 0.0
    cache_key: Optional[str] = None


class OptimizeTrace(TypedDict):
    hash: str
    latencyMs: int
    transport: str


class OptimizeResult(TypedDict):
    optimized: str
    tokensSaved: int
    cacheHit: bool
    fallbackUsed: bool
    trace: OptimizeTrace


async def optimize(
    *,
    prompt: str,
    context: str = "other",
    model: Optional[str] = None,
    max_loss_budget: float = 0.0,
    cache_key: Optional[str] = None,
) -> OptimizeResult:
    """
    Optimize a prompt. Returns the optimized text plus telemetry. Never
    throws — failures fall back to returning the input unchanged.
    """
    start = time.monotonic()
    h = cache_key or hash_key(prompt=prompt, model=model, max_loss_budget=max_loss_budget)

    # 1. Cache lookup
    cached = await get_cached(h)
    if cached:
        tokens_saved = max(0, estimate_tokens(prompt) - estimate_tokens(cached["optimized"]))
        latency_ms = int((time.monotonic() - start) * 1000)
        await emit(
            {
                "event": "prompt_master.optimize",
                "context": context,
                "tokensSaved": tokens_saved,
                "cacheHit": True,
                "latencyMs": latency_ms,
                "transport": "cache",
            }
        )
        return {
            "optimized": cached["optimized"],
            "tokensSaved": tokens_saved,
            "cacheHit": True,
            "fallbackUsed": False,
            "trace": {"hash": h, "latencyMs": latency_ms, "transport": "cache"},
        }

    # 2. Transport dispatch
    transport = get_transport()
    try:
        result = await transport.optimize(
            prompt=prompt,
            context=context,
            model=model,
            max_loss_budget=max_loss_budget,
        )
        optimized = result["optimized"]
        tokens_saved = max(0, estimate_tokens(prompt) - estimate_tokens(optimized))
        latency_ms = int((time.monotonic() - start) * 1000)

        # Don't cache pass-through results (null transport or identity).
        is_passthrough = transport.name == "null" or optimized == prompt
        if not is_passthrough:
            await put_cached(h, optimized)

        if is_passthrough:
            await emit(
                {
                    "event": "prompt_master.fallback",
                    "context": context,
                    "reason": "no transport configured" if transport.name == "null" else "transport returned input unchanged",
                }
            )
        else:
            await emit(
                {
                    "event": "prompt_master.optimize",
                    "context": context,
                    "tokensSaved": tokens_saved,
                    "cacheHit": False,
                    "latencyMs": latency_ms,
                    "transport": transport.name,
                }
            )

        return {
            "optimized": optimized,
            "tokensSaved": tokens_saved,
            "cacheHit": False,
            "fallbackUsed": is_passthrough,
            "trace": {"hash": h, "latencyMs": latency_ms, "transport": transport.name},
        }
    except Exception as exc:  # noqa: BLE001 - any transport failure is non-fatal
        latency_ms = int((time.monotonic() - start) * 1000)
        await emit(
            {
                "event": "prompt_master.fallback",
                "context": context,
                "reason": f"transport error: {exc}",
            }
        )
        return {
            "optimized": prompt,
            "tokensSaved": 0,
            "cacheHit": False,
            "fallbackUsed": True,
            "trace": {"hash": h, "latencyMs": latency_ms, "transport": transport.name},
        }
