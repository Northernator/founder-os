"""
Transport registry. Mirrors src/client.ts.

The library is transport-agnostic. Apps wire in a real transport at startup
(Anthropic API + Prompt Master skill, a local prompt-master binary, an HTTP
service, whatever). Until they do, the null transport is used and
optimization is a no-op pass-through.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable, Protocol

from .fallback import NULL_TRANSPORT


class Transport(Protocol):
    """Protocol every transport must satisfy."""

    name: str

    async def optimize(self, *, prompt: str, **kwargs: object) -> dict: ...


_active_transport: object = NULL_TRANSPORT


def set_transport(transport: Transport) -> None:
    global _active_transport
    _active_transport = transport


def get_transport() -> Transport:
    return _active_transport  # type: ignore[return-value]


def reset_transport() -> None:
    global _active_transport
    _active_transport = NULL_TRANSPORT


@dataclass
class _FunctionTransport:
    name: str
    fn: Callable[..., Awaitable[dict]]

    async def optimize(self, *, prompt: str, **kwargs: object) -> dict:
        return await self.fn(prompt=prompt, **kwargs)


def as_transport(name: str, fn: Callable[..., Awaitable[dict]]) -> Transport:
    """
    Wrap an async function as a transport. Useful for ad-hoc test harnesses
    or when the host app's optimizer is just a function.

    Example:
        async def my_optimizer(*, prompt, **_):
            return {"optimized": await call_prompt_master(prompt)}

        set_transport(as_transport("anthropic-skill", my_optimizer))
    """
    return _FunctionTransport(name=name, fn=fn)  # type: ignore[return-value]
