"""FastAPI app entry point.

Imported by uvicorn as `research_py.main:app`.
"""

from contextlib import asynccontextmanager
import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from research_py import __version__
from research_py.config import apply_gpt_researcher_env, settings
from research_py.prompt_master import set_transport
from research_py.routes import health
from research_py.routes import research
from research_py.routes import scrape
from research_py.routes import search

logging.basicConfig(
    level=settings.log_level.upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("research_py")

# Set GPT-Researcher's expected env vars BEFORE any gpt_researcher import
# happens. The library reads RETRIEVER / FAST_LLM / etc. eagerly when its
# config module is loaded, so doing this at module top is the safest spot.
# routes/research.py imports gpt_researcher lazily (inside the worker
# coroutine) so this still completes first regardless.
apply_gpt_researcher_env()


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info(
        "research-py %s starting | searxng=%s | firecrawl=%s | ventures=%s | "
        "llm_provider=%s",
        __version__,
        settings.searxng_url,
        settings.firecrawl_url,
        settings.ventures_dir,
        settings.llm_provider,
    )
    # Wire up Prompt Master if ANTHROPIC_API_KEY is in env. Lazy import of
    # anthropic so a partial install doesn't break startup. No key = null
    # transport = optimize() pass-through.
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if api_key:
        try:
            from anthropic import AsyncAnthropic  # type: ignore[import-not-found]
            from research_py.prompt_master.transports.anthropic_skill import (
                create_anthropic_skill_transport,
            )
            set_transport(
                create_anthropic_skill_transport(
                    client=AsyncAnthropic(api_key=api_key),
                    model="claude-haiku-4-5-20251001",
                )
            )
            log.info("prompt-master: anthropic-skill transport registered")
        except Exception as exc:  # noqa: BLE001 - non-fatal
            log.warning("prompt-master: transport setup failed (%s); falling back to no-op", exc)
    else:
        log.info("prompt-master: no ANTHROPIC_API_KEY; optimization disabled")
    yield
    log.info("research-py shutting down")


app = FastAPI(
    title="Founder OS research-py",
    description=(
        "Research sidecar for Founder OS. Phase 2a: proxies SearXNG + Firecrawl. "
        "Phase 2b: GPT-Researcher deep-research jobs. "
        "Phase 2c: STORM, Crawl4AI, ScrapeGraphAI, Trafilatura, Docling, pydantic-ai."
    ),
    version=__version__,
    lifespan=lifespan,
)

# Permissive CORS - this service only ever listens on localhost.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(search.router)
app.include_router(scrape.router)
app.include_router(research.router)


@app.get("/", include_in_schema=False)
async def root() -> dict:
    return {
        "service": "research-py",
        "version": __version__,
        "docs": "/docs",
        "health": "/health",
    }
