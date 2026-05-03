"""ICP synthesis -- pydantic-ai agent over 01_research/ artifacts.

Phase 2c-icp. Reads the deep-research summary plus every competitor's
landing/about/pricing markdown, asks the agent for 1-3 target personas
in PersonaSchema shape (id, name, description, painPoints[], primaryGoal),
and writes:

    02_validation/icp/icp.yaml   -- structured personas + summary
    02_validation/icp/icp.md     -- human-readable narrative

Field names match @founder-os/domain PersonaSchema (camelCase) so the
YAML drops directly into the spec stage without a translation layer.

The pydantic-ai dep is lazy-imported inside synthesize_icp so a partial
install doesn't break the rest of the service.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from pydantic import BaseModel, Field

from research_py.config import _DEFAULT_LLMS, settings as default_settings

log = logging.getLogger("research_py.icp")

# Cap per-file slice to keep the prompt reasonable. Most pages are well
# under this; the cap kicks in for the occasional 30KB landing page.
_PER_FILE_CHAR_CAP = 6000
# Hard cap on total context we'll send -- protects against a venture
# with 20 competitors blowing the prompt budget.
_TOTAL_CHAR_CAP = 60_000


# ----------------------------- schema -----------------------------


class IcpPersona(BaseModel):
    """One persona inside the ICP. Field names match @founder-os/domain
    PersonaSchema (camelCase) so the YAML output drops directly into the
    spec stage."""

    id: str = Field(
        default="",
        description=(
            "Stable slug, e.g. 'solo-saas-founder'. Optional -- the route "
            "handler fills it from the name if the agent omits it."
        ),
    )
    name: str = Field(description="Human-readable label, e.g. 'Solo SaaS Founder'")
    description: str = Field(
        description="One-paragraph context: role, company size, daily reality"
    )
    painPoints: list[str] = Field(
        default_factory=list,
        description="Concrete pain points the user feels today",
    )
    primaryGoal: str = Field(
        default="",
        description="The job-to-be-done -- why they would hire this product",
    )


class IcpSynthesis(BaseModel):
    """Top-level ICP output. The agent is constrained to this shape."""

    summary: str = Field(
        description="One-paragraph narrative of the overall target ICP segment"
    )
    personas: list[IcpPersona] = Field(
        description="1 to 3 target personas, ordered by priority"
    )


# ----------------------------- I/O -----------------------------


def _slugify(name: str) -> str:
    s = name.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = s.strip("-")
    return s or "persona"


def _truncate(text: str, cap: int) -> str:
    if len(text) <= cap:
        return text
    return text[:cap] + "\n\n[... truncated for context budget ...]"


def gather_inputs(venture_root: Path) -> dict[str, str]:
    """Walk the venture's 01_research/ tree and read the input artifacts.

    Returns a {label: text} dict in stable order. Empty if the venture
    has no research artifacts yet -- caller decides how to handle that.
    """
    inputs: dict[str, str] = {}

    # Deep-research summary (optional but high-signal).
    summary_path = venture_root / "01_research" / "market-gaps" / "research-summary.md"
    if summary_path.is_file():
        try:
            text = summary_path.read_text(encoding="utf-8", errors="replace")
            inputs["market_gaps_summary"] = _truncate(text, _PER_FILE_CHAR_CAP)
        except OSError as exc:
            log.warning("read failed for %s: %s", summary_path, exc)

    # Per-competitor markdowns. Sorted for deterministic prompt order.
    competitors_dir = venture_root / "01_research" / "competitors"
    if competitors_dir.is_dir():
        for comp_dir in sorted(competitors_dir.iterdir()):
            if not comp_dir.is_dir():
                continue
            for kind in ("landing.md", "about.md", "pricing.md"):
                fpath = comp_dir / kind
                if not fpath.is_file():
                    continue
                try:
                    text = fpath.read_text(encoding="utf-8", errors="replace")
                except OSError as exc:
                    log.warning("read failed for %s: %s", fpath, exc)
                    continue
                inputs[f"competitor::{comp_dir.name}::{kind}"] = _truncate(
                    text, _PER_FILE_CHAR_CAP
                )

    return inputs


def _format_user_prompt(venture_slug: str, inputs: dict[str, str]) -> str:
    """Stitch the gathered inputs into a single user message.

    Sections are labelled and separated with markdown headers so the
    model can attribute pain-point claims back to specific evidence.
    Total length is capped at _TOTAL_CHAR_CAP -- if we exceed it, drop
    later items rather than truncating mid-section.
    """
    parts: list[str] = [
        f"Venture slug: `{venture_slug}`",
        "",
        (
            "Below is the research evidence we have gathered for this venture. "
            "Synthesise the ideal customer profile (ICP). Identify 1-3 personas "
            "that the venture should target first, ordered by priority. Each "
            "persona must be grounded in the evidence -- do not invent pains "
            "or goals that are not visible in the source material. If the "
            "evidence is thin, output fewer personas rather than padding."
        ),
        "",
    ]
    running_total = sum(len(p) for p in parts)
    for label, text in inputs.items():
        section = f"\n## {label}\n\n{text}\n"
        if running_total + len(section) > _TOTAL_CHAR_CAP:
            log.info(
                "icp prompt budget exhausted at %d chars; skipping remaining inputs",
                running_total,
            )
            break
        parts.append(section)
        running_total += len(section)
    return "\n".join(parts)


# ----------------------------- agent -----------------------------


SYSTEM_PROMPT = (
    "You are an ICP (ideal customer profile) analyst for an early-stage "
    "founder. Given a venture's research evidence (market analysis + "
    "competitor landing/about/pricing copy), identify the 1-3 personas "
    "the venture should target first.\n\n"
    "Constraints:\n"
    "- Ground every painPoint and primaryGoal in the evidence. Do not "
    "  invent. If you are unsure, omit the field rather than fabricate.\n"
    "- Prefer specific, role-shaped names (e.g. 'Series-A growth PM') "
    "  over vague ones (e.g. 'Tech User').\n"
    "- Description should be one paragraph, 2-4 sentences, covering role, "
    "  company stage/size, and the daily reality that makes them open to "
    "  a new tool.\n"
    "- painPoints: 3-7 concrete bullet points, each one a single quotable "
    "  pain (not a paragraph).\n"
    "- primaryGoal is one sentence in the form 'Help me <do X> so that <Y>'.\n"
    "- summary: one paragraph, 3-5 sentences, describing the overall ICP "
    "  segment -- the through-line across the personas you returned."
)


def _pick_smart_model() -> str:
    """Resolve which provider:model string to hand pydantic-ai. Mirrors
    the precedence in apply_gpt_researcher_env: explicit RESEARCH_PY_SMART_LLM
    wins, otherwise the per-provider default."""
    if default_settings.smart_llm:
        return default_settings.smart_llm
    return _DEFAULT_LLMS[default_settings.llm_provider]["smart"]


async def synthesize_icp(venture_slug: str, venture_root: Path) -> IcpSynthesis:
    """Run the ICP agent. Caller is responsible for writing the result.

    Raises if pydantic-ai is not installed or the agent run fails. Empty
    inputs are NOT a hard error -- the agent still runs, but the result
    will reflect the lack of evidence (likely a single very tentative
    persona). The route handler can choose to refuse on empty inputs if
    we want stricter behaviour later.
    """
    inputs = gather_inputs(venture_root)
    if not inputs:
        log.warning(
            "icp | no research inputs found for %s -- agent will get an empty prompt",
            venture_slug,
        )

    # Lazy import so a partial install doesn't crash the rest of the app.
    from pydantic_ai import Agent  # type: ignore[import-not-found]

    model = _pick_smart_model()
    agent = Agent(
        model,
        output_type=IcpSynthesis,
        system_prompt=SYSTEM_PROMPT,
    )
    user_prompt = _format_user_prompt(venture_slug, inputs)
    log.info(
        "icp | running agent | model=%s | prompt_chars=%d | inputs=%d",
        model, len(user_prompt), len(inputs),
    )

    result = await agent.run(user_prompt)
    # pydantic-ai 0.0.x exposes the typed result on `.data`; 0.1+ on
    # `.output`. Try both.
    data = getattr(result, "data", None)
    if data is None:
        data = getattr(result, "output", None)
    if not isinstance(data, IcpSynthesis):
        raise RuntimeError(
            f"pydantic-ai returned unexpected shape: {type(data).__name__}"
        )

    # Backfill missing ids from names. The agent often omits id since
    # it isn't a meaningful free-text field.
    seen: set[str] = set()
    for i, p in enumerate(data.personas):
        if not p.id:
            base = _slugify(p.name) or f"p{i + 1}"
        else:
            base = p.id
        candidate = base
        n = 2
        while candidate in seen:
            candidate = f"{base}-{n}"
            n += 1
        p.id = candidate
        seen.add(candidate)

    return data


# ----------------------------- writers -----------------------------


def render_icp_markdown(venture_slug: str, synthesis: IcpSynthesis) -> str:
    """Pretty markdown for icp.md. Section per persona; readable prose
    rather than YAML-in-disguise."""
    lines: list[str] = [
        f"# ICP -- {venture_slug}",
        "",
        "## Summary",
        "",
        synthesis.summary,
        "",
    ]
    for i, p in enumerate(synthesis.personas, start=1):
        lines.append(f"## Persona {i}: {p.name}")
        lines.append("")
        lines.append(f"_id: `{p.id}`_")
        lines.append("")
        lines.append(p.description)
        lines.append("")
        if p.painPoints:
            lines.append("**Pain points**")
            lines.append("")
            for pain in p.painPoints:
                lines.append(f"- {pain}")
            lines.append("")
        if p.primaryGoal:
            lines.append("**Primary goal**")
            lines.append("")
            lines.append(p.primaryGoal)
            lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def write_icp_artifacts(
    venture_root: Path, venture_slug: str, synthesis: IcpSynthesis
) -> tuple[Path, Path]:
    """Write icp.yaml + icp.md under 02_validation/icp/. Returns the two
    paths so the route handler can include them in the job result."""
    import yaml  # lazy import; pyyaml is in [agents] extras.

    out_dir = venture_root / "02_validation" / "icp"
    out_dir.mkdir(parents=True, exist_ok=True)

    yaml_path = out_dir / "icp.yaml"
    md_path = out_dir / "icp.md"

    payload = {
        "venture_slug": venture_slug,
        "summary": synthesis.summary,
        "personas": [p.model_dump() for p in synthesis.personas],
    }
    yaml_path.write_text(
        yaml.safe_dump(payload, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )
    md_path.write_text(
        render_icp_markdown(venture_slug, synthesis),
        encoding="utf-8",
    )
    return yaml_path, md_path
