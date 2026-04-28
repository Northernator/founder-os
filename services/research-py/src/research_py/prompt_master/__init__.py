"""
prompt_master — shared optimizer mirror for research-py.

Mirrors the @founder-os/prompt-master TypeScript package contract so both
sides of the stack share the same shape and telemetry. See
packages/prompt-master/src/types.ts for the source-of-truth contract.

Typical app startup:

    from research_py.prompt_master import set_transport, as_transport
    set_transport(as_transport("anthropic-skill",
                               lambda inp: call_prompt_master(inp.prompt)))

Then anywhere:

    from research_py.prompt_master import optimize
    result = await optimize(prompt=system_prompt, context="research")
"""
from .core import optimize, OptimizeInput, OptimizeResult
from .client import set_transport, get_transport, reset_transport, as_transport, Transport
from .fallback import NULL_TRANSPORT
from .hash import hash_key, estimate_tokens, PROMPT_MASTER_CACHE_VERSION
from .cache import inspect_cache
from .telemetry import get_log_file

__all__ = [
    "optimize",
    "OptimizeInput",
    "OptimizeResult",
    "Transport",
    "set_transport",
    "get_transport",
    "reset_transport",
    "as_transport",
    "NULL_TRANSPORT",
    "hash_key",
    "estimate_tokens",
    "PROMPT_MASTER_CACHE_VERSION",
    "inspect_cache",
    "get_log_file",
]
