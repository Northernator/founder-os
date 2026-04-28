"""Firecrawl client (self-hosted v1 API).

Reference: https://docs.firecrawl.dev/api-reference/endpoint/scrape
The self-hosted API matches the public one - same routes, same payloads.
Auth is optional locally (USE_DB_AUTHENTICATION=false). When TEST_API_KEY
is set on the api container, the same value must be sent as a Bearer token
from us.
"""

from typing import Any, Literal

import httpx
from pydantic import BaseModel, Field

from research_py.config import settings

ScrapeFormat = Literal["markdown", "html", "rawHtml", "links", "screenshot"]


class ScrapeRequest(BaseModel):
    url: str
    formats: list[ScrapeFormat] = Field(default_factory=lambda: ["markdown"])
    only_main_content: bool = Field(default=True, alias="onlyMainContent")
    wait_for: int = Field(default=0, alias="waitFor")  # ms
    timeout: int = Field(default=30000)  # ms

    model_config = {"populate_by_name": True}


class ScrapeMetadata(BaseModel):
    title: str | None = None
    description: str | None = None
    language: str | None = None
    source_url: str | None = Field(default=None, alias="sourceURL")
    status_code: int | None = Field(default=None, alias="statusCode")

    model_config = {"populate_by_name": True, "extra": "allow"}


class ScrapeData(BaseModel):
    markdown: str | None = None
    html: str | None = None
    raw_html: str | None = Field(default=None, alias="rawHtml")
    links: list[str] | None = None
    metadata: ScrapeMetadata | None = None

    model_config = {"populate_by_name": True}


class ScrapeResponse(BaseModel):
    success: bool
    data: ScrapeData | None = None
    warning: str | None = None


def _headers() -> dict[str, str]:
    h = {"Content-Type": "application/json"}
    if settings.firecrawl_api_key:
        h["Authorization"] = f"Bearer {settings.firecrawl_api_key}"
    return h


async def scrape(req: ScrapeRequest) -> ScrapeResponse:
    """POST /v1/scrape - fetch a single URL and return structured content."""

    body: dict[str, Any] = req.model_dump(by_alias=True, exclude_none=True)

    async with httpx.AsyncClient(timeout=settings.scrape_timeout_s) as client:
        r = await client.post(
            f"{settings.firecrawl_url}/v1/scrape",
            json=body,
            headers=_headers(),
        )
        r.raise_for_status()
        return ScrapeResponse.model_validate(r.json())


async def health() -> bool:
    """Lightweight reachability check - the API root returns a banner JSON."""

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{settings.firecrawl_url}/", headers=_headers())
            return r.status_code < 500
    except httpx.HTTPError:
        return False
