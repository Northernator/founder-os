"""Health endpoints.

GET /health        - liveness, just confirms the process is up.
GET /health/deps   - readiness, pings SearXNG + Firecrawl.
"""

from fastapi import APIRouter
from pydantic import BaseModel

from research_py import __version__
from research_py.clients import firecrawl
from research_py.clients import searxng
from research_py.config import settings

router = APIRouter(prefix="/health", tags=["health"])


class HealthResponse(BaseModel):
    status: str
    version: str


class DepStatus(BaseModel):
    name: str
    url: str
    healthy: bool
    detail: str = ""


class DepsResponse(BaseModel):
    healthy: bool
    deps: list[DepStatus]


@router.get("", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__)


@router.get("/deps", response_model=DepsResponse)
async def deps() -> DepsResponse:
    statuses: list[DepStatus] = []

    # SearXNG - run a trivial query to confirm JSON is enabled.
    try:
        await searxng.search("ping", limit=1)
        statuses.append(
            DepStatus(name="searxng", url=settings.searxng_url, healthy=True)
        )
    except Exception as e:  # noqa: BLE001
        statuses.append(
            DepStatus(
                name="searxng",
                url=settings.searxng_url,
                healthy=False,
                detail=str(e),
            )
        )

    # Firecrawl - banner only, no scrape (avoid burning a real fetch on probes).
    fc_ok = await firecrawl.health()
    statuses.append(
        DepStatus(
            name="firecrawl",
            url=settings.firecrawl_url,
            healthy=fc_ok,
            detail="" if fc_ok else "API root unreachable or 5xx",
        )
    )

    return DepsResponse(
        healthy=all(s.healthy for s in statuses),
        deps=statuses,
    )
