# services/research-py/Dockerfile
# Phase 2b + 2c-competitors: FastAPI sidecar that
#   - proxies SearXNG + Firecrawl  (2a)
#   - runs GPT-Researcher deep-research jobs  (2b)
#   - runs Crawl4AI + ScrapeGraphAI competitor scans  (2c-competitors)
#
# Image size growth:
#   2a -> ~200MB
#   2b -> ~900MB (langchain + tiktoken + lxml)
#   2c-competitors -> ~1.4GB (Crawl4AI brings playwright + chromium)

FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# System deps in two groups:
#  (a) build/runtime libs for python deps (lxml, tiktoken, python-magic)
#  (b) headless-chromium runtime libs for Playwright (Crawl4AI's browser).
#
# DO NOT clean apt lists here - `playwright install --with-deps chromium`
# below uses apt to backstop anything we missed. Cleanup runs after that.
#
# Lesson 2026-04-28: hand-pinned list missed libxfixes3 / libnspr4 /
# libxext6 / libxrender1 / libxtst6 / libdbus-1-3 / libdrm2 / libxcb1 /
# libatspi2.0-0; chromium crashed with `libXfixes.so.3 not found`.
# Fix: include those AND let --with-deps backstop future additions.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      build-essential \
      python3-dev \
      libxml2 \
      libxml2-dev \
      libxslt1.1 \
      libxslt1-dev \
      libmagic1 \
      libnss3 \
      libnspr4 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libatspi2.0-0 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libxcb1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxcomposite1 \
      libxdamage1 \
      libxrandr2 \
      libxrender1 \
      libxtst6 \
      libgbm1 \
      libpango-1.0-0 \
      libpangocairo-1.0-0 \
      libcairo2 \
      libasound2 \
      libxshmfence1 \
      fonts-liberation \
      ca-certificates

RUN pip install uv==0.5.11

WORKDIR /app

# Non-editable install so hatchling sequencing works in containers.
# uv pip resolution is the slow step (~3-4 min with both extras); cached
# until pyproject.toml or src/ change.
COPY pyproject.toml README.md ./
COPY src ./src

RUN uv venv /app/.venv && \
    . /app/.venv/bin/activate && \
    uv pip install ".[research,scraping,agents]"

# Install chromium for Playwright. --with-deps adds any libs our explicit
# apt list missed, then we clean apt - this is the last apt-using step.
RUN . /app/.venv/bin/activate && \
    playwright install --with-deps chromium && \
    rm -rf /var/lib/apt/lists/*

ENV PATH="/app/.venv/bin:$PATH"

EXPOSE 3030

CMD ["uvicorn", "research_py.main:app", \
     "--host", "0.0.0.0", "--port", "3030", \
     "--proxy-headers", "--forwarded-allow-ips=*"]
