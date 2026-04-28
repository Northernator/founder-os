# research-py

Python sidecar for Founder OS. Runs as a Docker service in `services/docker-compose.yml`, exposed on `:3030`.

## Phasing

This is **phase 2a**: a thin FastAPI app that proxies SearXNG + Firecrawl. Heavy ML/agent libraries land in subsequent phases:

| Phase | What lands | Endpoints |
|---|---|---|
| **2a (now)** | FastAPI shell, SearXNG + Firecrawl clients | `GET /health`, `GET /health/deps`, `GET /search`, `POST /search`, `POST /scrape` |
| 2b | GPT-Researcher | `POST /research/deep` (currently stubbed at 501) |
| 2c | STORM, Crawl4AI, ScrapeGraphAI, Trafilatura, Docling, pydantic-ai | `POST /research/competitors`, `POST /research/icp`, etc. |

Stubs for 2b/2c return `501` with a clear error message so the TypeScript `research-runner` package can already code against the contract.

## API surface (phase 2a)

```
GET  /                       service banner
GET  /docs                   OpenAPI/Swagger UI
GET  /health                 process liveness
GET  /health/deps            readiness - pings SearXNG + Firecrawl
GET  /search?q=...&limit=20  quick search via SearXNG JSON
POST /search                 full search (categories, engines, language, ...)
POST /scrape                 single-URL scrape via Firecrawl /v1/scrape
POST /research/deep          [501 - phase 2b]
POST /research/competitors   [501 - phase 2c]
POST /research/icp           [501 - phase 2c]
```

## Configuration

All env vars are prefixed `RESEARCH_PY_`. Defaults assume the docker-compose service names.

| Var | Default | Purpose |
|---|---|---|
| `RESEARCH_PY_SEARXNG_URL` | `http://searxng:8080` | SearXNG JSON API |
| `RESEARCH_PY_FIRECRAWL_URL` | `http://firecrawl-api:3002` | Firecrawl self-hosted API |
| `RESEARCH_PY_FIRECRAWL_API_KEY` | (empty) | Bearer token if Firecrawl is gated |
| `RESEARCH_PY_VENTURES_DIR` | `/ventures` | Where to write venture artifacts |
| `RESEARCH_PY_HTTP_TIMEOUT_S` | `30` | Default upstream timeout |
| `RESEARCH_PY_SCRAPE_TIMEOUT_S` | `120` | Scrape-specific timeout |
| `RESEARCH_PY_LOG_LEVEL` | `info` | uvicorn-compatible log level |

## Layout

```
services/research-py/
├─ Dockerfile
├─ pyproject.toml             # phase deps; ML libs in optional extras
├─ src/research_py/
│  ├─ main.py                 # FastAPI app, mounts routers
│  ├─ config.py               # pydantic-settings, env-driven
│  ├─ clients/
│  │  ├─ searxng.py           # GET /search?format=json, typed responses
│  │  └─ firecrawl.py         # POST /v1/scrape, typed responses
│  └─ routes/
│     ├─ health.py            # / /deps
│     ├─ search.py            # GET + POST /search
│     ├─ scrape.py            # POST /scrape
│     └─ research.py          # /research/* - phase 2b/2c stubs
└─ tests/                     # pytest tests (placeholder)
```

## Local iteration without docker

```powershell
cd services/research-py
uv venv
.\.venv\Scripts\Activate.ps1
uv pip install -e ".[dev]"

# point at the docker-running upstream services
$env:RESEARCH_PY_SEARXNG_URL = "http://localhost:8080"
$env:RESEARCH_PY_FIRECRAWL_URL = "http://localhost:3002"

uvicorn research_py.main:app --reload --port 3030
```

The auto-reload setup means you can edit `src/research_py/**` and it picks up immediately, while the heavy SearXNG + Firecrawl stack stays running in containers.

## When to add deps

When phase 2b lands, uncomment the `gpt-researcher` line in `pyproject.toml [project.optional-dependencies].research`, then update the `Dockerfile`'s `uv pip install` to:

```
uv pip install -e ".[research]"
```

Same pattern for `[scraping]` and `[agents]` in 2c. Each addition rebuilds the deps layer; the source-code layer stays small so iteration after deps are stable is fast.
