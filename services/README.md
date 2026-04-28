# services/

External research sidecars. **Not a pnpm workspace package** — these are Docker services we run alongside the app, not TypeScript libraries we import.

## What's here

| Service | License | Port | Purpose |
|---|---|---|---|
| **SearXNG** | AGPL-3.0 | 8080 | Self-hosted metasearch (70+ engines), free unlimited queries |
| **Firecrawl** (api + workers) | AGPL-3.0 | 3002 | Scrape + crawl + map via the harness process |
| **research-py** | MIT (ours) | 3030 | FastAPI orchestrator; talks to SearXNG + Firecrawl, exposes `/search`, `/scrape`, `/research/*` |
| Redis (Firecrawl) | BSD | internal | Bull queue + rate limits for Firecrawl |
| RabbitMQ | MPL-2.0 | internal | NUQ work queue Firecrawl uses |
| nuq-postgres | PostgreSQL | internal | NUQ job state Firecrawl uses |
| Playwright service | MIT | internal | Headless browser pool used by Firecrawl |

## Why a sidecar instead of a package

Both SearXNG and Firecrawl are **AGPL-3.0**. If we imported their code into the proprietary monorepo, the whole product would become AGPL-encumbered. By running them as standalone Docker services and talking to them only over HTTP on localhost, we use them without copyleft contamination — same pattern we use for Penpot on the design side.

`packages/research-runner` (TypeScript, when it exists) calls `http://localhost:8080/search?format=json` and `http://localhost:3002/v1/scrape` — that's the entire integration surface. No imports, no shared types, no contamination.

## Quick start

```powershell
# from D:\FOUNDER_AI\founder-os-fixed\founder-os\

# first run only — copy env template
cp services/.env.example services/.env

# bring it up (auto-generates SearXNG secret on first run)
.\services\scripts\up.ps1

# verify
.\services\scripts\health-check.ps1

# stop
.\services\scripts\down.ps1

# stop and wipe Redis state
.\services\scripts\down.ps1 -Volumes
```

## Verifying it works

After `up.ps1` finishes the health check should print `ALL HEALTHY`. If you want to poke manually:

```powershell
# SearXNG JSON
curl "http://localhost:8080/search?q=founder+os&format=json"

# Firecrawl scrape
curl -X POST http://localhost:3002/v1/scrape `
  -H "Content-Type: application/json" `
  -d '{\"url\":\"https://example.com\",\"formats\":[\"markdown\"]}'
```

## Troubleshooting

**`docker compose pull` returns 401 from `ghcr.io/firecrawl/...`**
GitHub Container Registry sometimes throttles unauthenticated pulls. Create a GitHub PAT with `read:packages` scope and:
```powershell
echo $env:GHCR_PAT | docker login ghcr.io -u <github-username> --password-stdin
```

**SearXNG returns HTML when you ask for `format=json`**
Open `services/searxng/settings.yml`, confirm `search.formats` includes `json`, and that `server.limiter` is `false`. Then `docker compose restart searxng`.

**Firecrawl scrape times out**
Usually means `playwright-service` hasn't finished starting. Wait 30s after `up.ps1`, retry. If still failing: `docker compose logs playwright-service --tail=100`.

**Port 8080 / 3002 already in use**
Change the host-side port in `docker-compose.yml` (e.g. `"18080:8080"`) and update `health-check.ps1` to match.

## Where this fits in the bigger picture

This is **steps 1-2a** of the research-tools integration plan in `bizBuild/RESEARCH_TOOLS_INTEGRATION.md`. Status:

1. ✅ `services/` with SearXNG + Firecrawl up on localhost
2. 🟡 `services/research-py/` — phase 2a done (FastAPI shell + SearXNG/Firecrawl proxy), 2b/2c pending (GPT-Researcher, STORM, Crawl4AI, ScrapeGraphAI, Trafilatura, Docling, pydantic-ai)
3. `packages/research-runner/` — TypeScript orchestrator that talks to (1) and (2)
4. `research.config.yaml` per venture
5. `/research`, `/competitors`, `/icp` slash commands wired into the desktop chat surface

See `services/research-py/README.md` for the phasing detail.

## License posture summary

- **Inside this folder:** AGPL services run as independent containers. Their AGPL obligations apply only to those containers, which we never modify and never redistribute.
- **In `packages/research-runner` (future):** MIT/Apache only — talks to AGPL services over HTTP, never imports their code.
- **In `services/research-py/` (future):** All Python deps must be MIT/Apache/BSD. Any GPL Python lib goes in a separate sidecar process, not the main `research-py` container.
