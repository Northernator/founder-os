"""
Null transport — returns input unchanged.

Used when no real Prompt Master transport has been registered. Optimization is
an enhancement, not a dependency: the system must keep working when the
upstream skill is unreachable, the API key is missing, or the user simply
hasn't wired in a transport yet.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class _NullTransport:
    name: str = "null"

    async def optimize(self, *, prompt: str, **_: object) -> dict:
        return {"optimized": prompt}


NULL_TRANSPORT = _NullTransport()
