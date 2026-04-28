"""
Reference transport: Anthropic API + Prompt Master skill (Python).

Optional helper. Mirrors packages/prompt-master/src/transports/anthropic-skill.ts.

Setup:
    1. Install the SDK in the host service:
        pip install anthropic

    2. Wire it in at startup:
        from anthropic import AsyncAnthropic
        from research_py.prompt_master import set_transport
        from research_py.prompt_master.transports.anthropic_skill import (
            create_anthropic_skill_transport,
        )

        set_transport(create_anthropic_skill_transport(
            client=AsyncAnthropic(api_key=os.environ["ANTHROPIC_API_KEY"]),
            model="claude-haiku-4-5-20251001",
        ))
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Protocol

PROMPT_MASTER_SYSTEM = """You are Prompt Master, a lossless prompt optimizer.

Your job: rewrite the user's prompt to use fewer tokens while preserving every
instruction, constraint, format requirement, and example. Do NOT drop content.
Do NOT paraphrase examples. Do NOT change meaning.

Output ONLY the optimized prompt. No explanation, no preamble, no metadata.

Rules:
- Use crisp imperative phrasing.
- Collapse redundant phrasing ("please make sure to" -> "must").
- Combine adjacent rules into a single sentence when meaning is preserved.
- Preserve all variable placeholders (e.g. {{name}}, [field]) verbatim.
- Preserve XML tags, code fences, and JSON shape examples verbatim.
- If the input is already minimal, return it unchanged."""


class _AsyncAnthropicLike(Protocol):
    """Structural type for the Anthropic AsyncAnthropic client."""

    messages: object  # has .create(...)


@dataclass
class _AnthropicSkillTransport:
    name: str
    client: _AsyncAnthropicLike
    model: str
    system: str
    max_tokens_override: Optional[int]

    async def optimize(self, *, prompt: str, **_: object) -> dict:
        max_tokens = self.max_tokens_override or max(256, (len(prompt) // 3) + 1)
        # Anthropic SDK's messages.create is async on AsyncAnthropic.
        resp = await self.client.messages.create(  # type: ignore[attr-defined]
            model=self.model,
            max_tokens=max_tokens,
            system=self.system,
            messages=[{"role": "user", "content": prompt}],
        )
        # resp.content is a list of content blocks; pick the text.
        text_parts: list[str] = []
        for block in getattr(resp, "content", []) or []:
            if getattr(block, "type", None) == "text":
                text_parts.append(getattr(block, "text", "") or "")
        text = "".join(text_parts).strip()
        # Defensive: empty response -> identity (core marks it fallback).
        return {"optimized": text if text else prompt}


def create_anthropic_skill_transport(
    *,
    client: _AsyncAnthropicLike,
    model: str = "claude-haiku-4-5-20251001",
    system_override: Optional[str] = None,
    max_tokens: Optional[int] = None,
) -> object:
    """Build a transport. Pass an AsyncAnthropic instance the host owns."""
    return _AnthropicSkillTransport(
        name="anthropic-skill",
        client=client,
        model=model,
        system=system_override or PROMPT_MASTER_SYSTEM,
        max_tokens_override=max_tokens,
    )
