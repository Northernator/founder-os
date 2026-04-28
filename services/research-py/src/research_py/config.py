"""Env-driven settings.

All endpoints default to the docker-compose service names. When running
the service outside docker (e.g. local dev with the rest of the stack
in containers), override via env vars.

Phase 2b adds LLM-provider config for GPT-Researcher. We keep the user-
facing knobs under the RESEARCH_PY_ prefix (consistent with existing
settings) and translate them into the bare env vars GPT-Researcher
expects (RETRIEVER, SEARX_URL, FAST_LLM, SMART_LLM, STRATEGIC_LLM,
EMBEDDING, OPENAI_API_KEY, ANTHROPIC_API_KEY, OLLAMA_BASE_URL) at
process startup via apply_gpt_researcher_env().
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

log = logging.getLogger("research_py.config")

LlmProvider = Literal["openai", "anthropic", "ollama"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="RESEARCH_PY_",
        env_file=".env",
        extra="ignore",
    )

    # Upstream service URLs - defaults are the docker-compose service names.
    searxng_url: str = Field(default="http://searxng:8080")
    firecrawl_url: str = Field(default="http://firecrawl-api:3002")

    # Optional shared secret for the local Firecrawl API. Empty = no auth.
    firecrawl_api_key: str = Field(default="")

    # Where to write venture artifacts (mounted from the host monorepo).
    ventures_dir: Path = Field(default=Path("/ventures"))

    # HTTP client timeouts.
    http_timeout_s: float = Field(default=30.0)
    scrape_timeout_s: float = Field(default=120.0)

    # Logging.
    log_level: str = Field(default="info")

    # ---------------- Phase 2b: GPT-Researcher LLM config -----------------
    # Which provider to use as the *default* LLM for research jobs. The
    # FAST/SMART/STRATEGIC slots all default to this provider's models, but
    # any of them can be overridden individually with their own env var.
    llm_provider: LlmProvider = Field(default="openai")

    # Per-provider credentials. Only the one matching llm_provider needs
    # to be set; the others can be empty. We pass these into
    # os.environ so GPT-Researcher's own loaders pick them up natively.
    openai_api_key: str = Field(default="")
    anthropic_api_key: str = Field(default="")
    ollama_base_url: str = Field(default="http://host.docker.internal:11434")

    # GPT-Researcher LLM slot config. Format is "<provider>:<model>".
    # If empty, sane defaults per llm_provider are used (see _default_llms).
    fast_llm: str = Field(default="")
    smart_llm: str = Field(default="")
    strategic_llm: str = Field(default="")
    embedding: str = Field(default="")


settings = Settings()


# Sensible defaults per provider. Picked to be cheap-ish for fast/embedding
# and smart for the report-writing slot. Override any of these via env vars.
_DEFAULT_LLMS: dict[LlmProvider, dict[str, str]] = {
    "openai": {
        "fast": "openai:gpt-4o-mini",
        "smart": "openai:gpt-4o",
        "strategic": "openai:gpt-4o",
        "embedding": "openai:text-embedding-3-small",
    },
    "anthropic": {
        # Anthropic doesn't ship embeddings; fall back to OpenAI for the
        # embedding slot. If you don't have an OpenAI key, override
        # RESEARCH_PY_EMBEDDING to an alternative (e.g. ollama:nomic-embed-text).
        "fast": "anthropic:claude-3-5-haiku-latest",
        "smart": "anthropic:claude-sonnet-4-6",
        "strategic": "anthropic:claude-opus-4-6",
        "embedding": "openai:text-embedding-3-small",
    },
    "ollama": {
        "fast": "ollama:llama3.2",
        "smart": "ollama:llama3.1:70b",
        "strategic": "ollama:llama3.1:70b",
        "embedding": "ollama:nomic-embed-text",
    },
}


def apply_gpt_researcher_env() -> None:
    """Translate Settings -> the env vars GPT-Researcher reads.

    Called once at FastAPI startup. GPT-Researcher reads these at import
    time of its config module, so we set them BEFORE we import gpt_researcher
    in routes/research.py.

    Idempotent: safe to call more than once.
    """
    s = settings
    defaults = _DEFAULT_LLMS[s.llm_provider]

    # Retriever: hard-wired to SearXNG. Phase 2b decision (see project memory).
    os.environ.setdefault("RETRIEVER", "searx")
    os.environ.setdefault("SEARX_URL", s.searxng_url)

    # LLM slot config. RESEARCH_PY_FAST_LLM etc. win; otherwise pick the
    # provider default.
    os.environ["FAST_LLM"] = s.fast_llm or defaults["fast"]
    os.environ["SMART_LLM"] = s.smart_llm or defaults["smart"]
    os.environ["STRATEGIC_LLM"] = s.strategic_llm or defaults["strategic"]
    os.environ["EMBEDDING"] = s.embedding or defaults["embedding"]

    # Provider credentials. Only set if non-empty so we don't clobber a
    # value already coming in from docker-compose / shell env.
    if s.openai_api_key:
        os.environ.setdefault("OPENAI_API_KEY", s.openai_api_key)
    if s.anthropic_api_key:
        os.environ.setdefault("ANTHROPIC_API_KEY", s.anthropic_api_key)
    if s.ollama_base_url:
        os.environ.setdefault("OLLAMA_BASE_URL", s.ollama_base_url)

    log.info(
        "GPT-Researcher env applied | provider=%s | retriever=%s | "
        "fast=%s | smart=%s | strategic=%s | embedding=%s",
        s.llm_provider,
        os.environ["RETRIEVER"],
        os.environ["FAST_LLM"],
        os.environ["SMART_LLM"],
        os.environ["STRATEGIC_LLM"],
        os.environ["EMBEDDING"],
    )

    # Friendly warning if the chosen provider has no credential set. Don't
    # raise - the service should still boot for the search/scrape endpoints.
    cred_for_provider = {
        "openai": "OPENAI_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
        "ollama": None,  # Ollama auths via base URL only.
    }[s.llm_provider]
    if cred_for_provider and not os.environ.get(cred_for_provider):
        log.warning(
            "llm_provider=%s but %s is empty - /research/deep will fail "
            "until this is set.",
            s.llm_provider,
            cred_for_provider,
        )
