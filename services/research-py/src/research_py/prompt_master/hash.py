"""Stable hashing for cache keys. Mirrors src/hash.ts."""
from __future__ import annotations

import hashlib
import json
import math
from typing import Optional

# Bump this when the upstream Prompt Master skill changes behaviour in a way
# that should invalidate previously cached results.
PROMPT_MASTER_CACHE_VERSION = 1


def hash_key(
    *,
    prompt: str,
    model: Optional[str] = None,
    max_loss_budget: float = 0.0,
) -> str:
    """SHA-256 over canonical inputs. Stable across processes."""
    canonical = json.dumps(
        {
            "v": PROMPT_MASTER_CACHE_VERSION,
            "p": prompt,
            "m": model or "",
            "l": max_loss_budget,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def estimate_tokens(text: str) -> int:
    """
    Rough token estimate. ~4 chars per token is the standard back-of-envelope
    for English prose; close enough for a "tokens saved" counter. Real model
    billing uses the model's tokenizer.
    """
    return math.ceil(len(text) / 4)
