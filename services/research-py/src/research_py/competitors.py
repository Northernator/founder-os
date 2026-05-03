"""Competitor scan: page discovery + Crawl4AI markdown + ScrapeGraphAI pricing.

Used by routes/research.py -> /research/competitors. Async throughout so
the FastAPI worker can process competitors concurrently.

Design choices (Phase 2c-competitors, 2026-04-27):
  - Page discovery is a heuristic HEAD-probe: try common landing/pricing/
    about paths; use the first one that returns 2xx/3xx. No LLM in the
    discovery loop. Misses get logged and skipped (we just don't write
    that file). See discover_pages().
  - Crawl4AI handles the markdown extraction. We use AsyncWebCrawler
    with default config; LLM-friendly markdown is its default output.
  - ScrapeGraphAI's SmartScraperGraph extracts structured pricing rows.
    Schema is the standard SaaS shape (PricingPlan below). LLM provider
    is whatever's configured in apply_gpt_researcher_env() at startup.
  - heavy deps (crawl4ai, scrapegraphai) are imported lazily inside
    each function so a partial install doesn't crash the import path.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx
from pydantic import BaseModel, Field

from research_py.config import settings

log = logging.getLogger("research_py.competitors")


# --------------------- Pricing schema (the CSV contract) ---------------------

class PricingPlan(BaseModel):
    """One row of the pricing CSV. ScrapeGraphAI fills these from the page."""

    plan_name: str = Field(description="Short marketing name of the plan, e.g. 'Pro' or 'Enterprise'")
    billing_period: str = Field(
        default="monthly",
        description="One of: monthly | annual | free | custom | unknown",
    )
    price_monthly: float | None = Field(default=None, description="Numeric monthly price in the listed currency, null if free/custom")
    price_annual: float | None = Field(default=None, description="Numeric annual price in the listed currency, null if not shown")
    currency: str | None = Field(default=None, description="ISO 4217 code, e.g. USD, GBP, EUR")
    included_features: list[str] = Field(default_factory=list, description="Bullet-point list as an array of strings")
    cta_text: str | None = Field(default=None, description="Text on the call-to-action button for this plan")
    target_segment: str | None = Field(
        default=None,
        description="Plan tier descriptor, e.g. 'Free', 'Startup', 'Pro', 'Enterprise'",
    )


class PricingExtraction(BaseModel):
    """Top-level shape ScrapeGraphAI returns: a list of PricingPlan rows."""

    plans: list[PricingPlan] = Field(default_factory=list)


# CSV header order. Kept stable so downstream readers don't break when we
# add fields - new fields go at the end.
CSV_FIELDS = (
    "competitor",
    "plan_name",
    "billing_period",
    "price_monthly",
    "price_annual",
    "currency",
    "included_features",  # pipe-separated
    "cta_text",
    "target_segment",
    "source_url",
)


# ----------------------- Slug + page-path heuristics ------------------------

# Foldername under 01_research/competitors/{slug}/. Strips protocol/www, keeps
# only host (drops path/query), replaces dots with hyphens, lowercase.
def derive_competitor_slug(url: str) -> str:
    parsed = urlparse(url if "://" in url else f"https://{url}")
    host = parsed.hostname or ""
    if host.startswith("www."):
        host = host[4:]
    slug = re.sub(r"[^a-z0-9]+", "-", host.lower()).strip("-")
    return slug or "competitor"


# Probe order for each page kind. First 2xx/3xx wins.
_PAGE_PATHS: dict[str, tuple[str, ...]] = {
    "landing": ("/",),
    "pricing": ("/pricing", "/pricing/", "/plans", "/plans/", "/price", "/prices"),
    "about": ("/about", "/about-us", "/about/", "/company", "/company/"),
}


@dataclass(frozen=True)
class DiscoveredPages:
    base: str
    landing: str
    pricing: str | None
    about: str | None


async def discover_pages(base_url: str, *, timeout_s: float = 8.0) -> DiscoveredPages:
    """HEAD-probe the standard SaaS page paths. First 2xx/3xx wins per kind.

    Landing always resolves to base (we treat the root as authoritative).
    Pricing and about are best-effort: None if every candidate path failed.
    """
    base = base_url if "://" in base_url else f"https://{base_url}"
    base = base.rstrip("/")

    async with httpx.AsyncClient(
        timeout=timeout_s,
        follow_redirects=True,
        headers={"User-Agent": "founder-os-research-py/0.2 (+https://github.com/)"},
    ) as client:
        async def first_ok(paths: tuple[str, ...]) -> str | None:
            for path in paths:
                url = urljoin(base + "/", path.lstrip("/"))
                try:
                    # HEAD often blocked; fall back to GET if HEAD 405s.
                    r = await client.head(url)
                    if r.status_code == 405:
                        r = await client.get(url)
                    if 200 <= r.status_code < 400:
                        return str(r.url)  # post-redirect URL
                except httpx.HTTPError as e:
                    log.debug("discover_pages probe failed %s: %s", url, e)
                    continue
            return None

        landing_task = first_ok(_PAGE_PATHS["landing"])
        pricing_task = first_ok(_PAGE_PATHS["pricing"])
        about_task = first_ok(_PAGE_PATHS["about"])
        landing, pricing, about = await asyncio.gather(
            landing_task, pricing_task, about_task
        )

    # If even the landing probe failed (rare), fall back to the raw base URL -
    # crawl4ai will get its own error, which the caller treats as a soft-fail.
    landing = landing or base
    return DiscoveredPages(base=base, landing=landing, pricing=pricing, about=about)


# --------------------------- Crawl4AI markdown ---------------------------

async def crawl_to_markdown(url: str) -> str:
    """Crawl a single URL and return clean markdown.

    Crawl4AI's AsyncWebCrawler ships chromium; default config gives
    LLM-friendly markdown out of the box. Errors bubble up - the caller
    decides whether one bad URL kills the whole job (we say no).
    """
    # Lazy import so the rest of the app boots without crawl4ai installed.
    from crawl4ai import AsyncWebCrawler  # type: ignore[import-not-found]

    async with AsyncWebCrawler(verbose=False) as crawler:
        result = await crawler.arun(url=url)

    if not getattr(result, "success", False):
        msg = getattr(result, "error_message", "unknown crawl error")
        raise RuntimeError(f"crawl4ai failed for {url}: {msg}")

    md = getattr(result, "markdown", "") or ""
    if not md.strip():
        raise RuntimeError(f"crawl4ai returned empty markdown for {url}")
    return md


# ---------------------- ScrapeGraphAI structured extract -------------------

# Map RESEARCH_PY_LLM_PROVIDER -> the dict shape ScrapeGraphAI expects.
def _scrapegraph_llm_config() -> dict[str, Any]:
    """Translate Settings into ScrapeGraphAI's `llm` config block.

    ScrapeGraphAI uses LangChain under the hood, so model strings look
    like "openai/gpt-4o" (slash, not colon). Provider key comes from
    the same env vars 2b's apply_gpt_researcher_env() set.
    """
    p = settings.llm_provider
    smart = settings.smart_llm  # e.g. "openai:gpt-4o"
    # Default per provider, mirrors config._DEFAULT_LLMS["smart"].
    if not smart:
        smart = {
            "openai": "openai:gpt-4o",
            "anthropic": "anthropic:claude-sonnet-4-6",
            "ollama": "ollama:llama3.1:70b",
        }[p]

    # Convert provider:model -> ScrapeGraphAI's "provider/model".
    provider, _, model = smart.partition(":")
    sg_model = f"{provider}/{model}" if model else smart

    cfg: dict[str, Any] = {"model": sg_model}
    if p == "openai":
        cfg["api_key"] = os.environ.get("OPENAI_API_KEY", "")
    elif p == "anthropic":
        cfg["api_key"] = os.environ.get("ANTHROPIC_API_KEY", "")
    elif p == "ollama":
        cfg["base_url"] = os.environ.get("OLLAMA_BASE_URL", "http://host.docker.internal:11434")
        cfg["model_tokens"] = 8192  # ScrapeGraphAI requires this for Ollama
    return cfg


async def extract_pricing(
    pricing_url: str, pricing_md: str | None = None
) -> tuple[list[PricingPlan], str | None]:
    """Extract structured pricing plans from a competitor's pricing page.

    Pass pricing_md if you already crawled the page (saves a re-fetch).
    Otherwise SmartScraperGraph fetches it itself.

    Returns (plans, error). On success error is None. On any failure mode
    (LLM exception, malformed shape, zero valid plans) the error string
    describes what happened so callers can surface it via errors[].
    """
    # Lazy import.
    from scrapegraphai.graphs import SmartScraperGraph  # type: ignore[import-not-found]
    from .prompt_master import optimize as pm_optimize

    # Prompt written in prose, NOT JSON-shape examples. ScrapeGraphAI
    # internally wraps this in a LangChain PromptTemplate, which treats
    # `{...}` as variable substitution and `{{...}}` as escaped braces.
    # When we used the literal example shape `{"plans": ...}` here, models
    # (notably Notion's pricing page on a smart slot of gpt-4o) echoed
    # `{{"plans": ...}}` back, which LangChain's JSON output parser then
    # rejected as "Invalid json". Prose-only avoids that whole class of
    # bug. See research_competitors_shipped.md memory for the original
    # incident (2026-04-30).
    prompt = (
        "Extract every pricing plan visible on this page. "
        "For each plan return the following fields: "
        "plan_name (short marketing name), "
        "billing_period (one of: monthly, annual, free, custom), "
        "price_monthly (numeric or null), "
        "price_annual (numeric or null), "
        "currency (ISO 4217 code), "
        "included_features (array of bullet strings), "
        "cta_text (button label), "
        "target_segment (e.g. Free, Startup, Pro, Enterprise). "
        "Output a single JSON object with exactly one top-level key named "
        "plans whose value is an array of plan objects. Do not include "
        "any prose, code fences, or wrapping characters around the JSON. "
        "Do not double-escape braces. "
        "If a field is not visible on the page, set it to null or an "
        "empty array/string rather than guessing."
    )

    # Optimize the prompt before sending to SmartScraperGraph. Falls back to
    # the original prompt if no Prompt Master transport is configured.
    pm_result = await pm_optimize(prompt=prompt, context="research")
    prompt = pm_result["optimized"]
    if pm_result["tokensSaved"] > 0:
        log.info("prompt-master saved ~%d tokens on pricing prompt", pm_result["tokensSaved"])

    graph_config = {
        "llm": _scrapegraph_llm_config(),
        "verbose": False,
        "headless": True,
    }

    # SmartScraperGraph is sync; offload to a thread so we don't block the
    # asyncio loop for the LLM round-trip.
    def _run() -> dict[str, Any]:
        # If we already have markdown, prefix it as inline source so SG can
        # work without a fresh fetch. SG accepts a URL or local content via
        # the `source` arg ("https://..." for fetch, "./file.html" for file,
        # or the raw text starts with content tags). For simplicity we fetch
        # again unless caller passed markdown.
        source = pricing_url if pricing_md is None else pricing_md
        sg = SmartScraperGraph(prompt=prompt, source=source, config=graph_config)
        return sg.run()

    try:
        raw = await asyncio.to_thread(_run)
    except Exception as exc:  # noqa: BLE001 - any LLM/network blowup is non-fatal
        log.warning("scrapegraphai pricing extract failed for %s: %s", pricing_url, exc)
        return [], f"scrapegraphai: {exc}"

    plans_raw = raw.get("plans") if isinstance(raw, dict) else None
    if not isinstance(plans_raw, list):
        log.warning("scrapegraphai returned no `plans` list for %s; raw=%r", pricing_url, raw)
        return [], f"scrapegraphai returned no `plans` list; raw={raw!r}"[:500]

    out: list[PricingPlan] = []
    drop_count = 0
    for item in plans_raw:
        try:
            out.append(PricingPlan.model_validate(item))
        except Exception as e:  # noqa: BLE001
            log.warning("dropping malformed pricing row from %s: %s | row=%r", pricing_url, e, item)
            drop_count += 1

    if not out:
        if drop_count:
            return [], f"scrapegraphai returned {drop_count} plans but all were malformed"
        return [], "scrapegraphai returned 0 plans"
    if drop_count:
        return out, f"{drop_count} malformed plans dropped"
    return out, None


# -------------------- Per-competitor end-to-end scan ----------------------

@dataclass
class CompetitorScanResult:
    """What one competitor's scan produced. Used by the route handler to
    build the job result + the cross-competitor pricing CSV."""

    url: str
    slug: str
    pages: DiscoveredPages
    landing_md: str | None
    pricing_md: str | None
    about_md: str | None
    pricing_plans: list[PricingPlan]
    errors: list[str]


async def scan_competitor(url: str) -> CompetitorScanResult:
    """Discover, crawl, and extract pricing for a single competitor URL.

    Catches per-step errors so one bad page doesn't sink the whole record.
    """
    pages = await discover_pages(url)
    errors: list[str] = []

    async def _safe_crawl(target: str | None) -> str | None:
        if not target:
            return None
        try:
            return await crawl_to_markdown(target)
        except Exception as e:  # noqa: BLE001
            errors.append(f"crawl {target}: {e}")
            log.warning("crawl failed | url=%s | err=%s", target, e)
            return None

    landing_md, pricing_md, about_md = await asyncio.gather(
        _safe_crawl(pages.landing),
        _safe_crawl(pages.pricing),
        _safe_crawl(pages.about),
    )

    # Extract structured pricing from the pricing page if we got one.
    pricing_plans: list[PricingPlan] = []
    if pages.pricing:
        try:
            pricing_plans, pricing_err = await extract_pricing(pages.pricing, pricing_md)
            if pricing_err:
                errors.append(f"pricing extract {pages.pricing}: {pricing_err}")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"pricing extract {pages.pricing}: {exc}")
            log.warning("pricing extract failed | url=%s | err=%s", pages.pricing, exc)

    return CompetitorScanResult(
        url=url,
        slug=derive_competitor_slug(url),
        pages=pages,
        landing_md=landing_md,
        pricing_md=pricing_md,
        about_md=about_md,
        pricing_plans=pricing_plans,
        errors=errors,
    )
