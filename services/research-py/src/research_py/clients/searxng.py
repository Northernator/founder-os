"""SearXNG client.

Reference: https://docs.searxng.org/dev/search_api.html
SearXNG returns a JSON document with a `results` array when format=json
and search.formats includes 'json' in settings.yml.
"""

from typing import Any

import httpx
from pydantic import BaseModel, Field

from research_py.config import settings


class SearchResult(BaseModel):
    """One row from SearXNG. SearXNG returns a richer payload than this;
    we surface only what we actually use downstream and stash the rest in
    `extra` for power users."""

    title: str
    url: str
    content: str = ""
    engine: str = ""
    score: float | None = None
    extra: dict[str, Any] = Field(default_factory=dict)


class SearchResponse(BaseModel):
    query: str
    number_of_results: int
    results: list[SearchResult]


async def search(
    query: str,
    *,
    categories: list[str] | None = None,
    engines: list[str] | None = None,
    language: str = "en",
    safesearch: int = 0,
    pageno: int = 1,
    limit: int | None = None,
) -> SearchResponse:
    """Run a SearXNG search and return parsed results.

    `limit` is enforced client-side - SearXNG itself returns whatever its
    upstream engines gave it.
    """

    params: dict[str, Any] = {
        "q": query,
        "format": "json",
        "language": language,
        "safesearch": safesearch,
        "pageno": pageno,
    }
    if categories:
        params["categories"] = ",".join(categories)
    if engines:
        params["engines"] = ",".join(engines)

    async with httpx.AsyncClient(timeout=settings.http_timeout_s) as client:
        # SearXNG's POST works in the docker-default config; GET needs the
        # limiter relaxed. settings.yml has both server.limiter=false and
        # method=POST, so this works either way - we use GET here for
        # simpler curl debugging.
        r = await client.get(f"{settings.searxng_url}/search", params=params)
        r.raise_for_status()
        data = r.json()

    raw_results = data.get("results", [])
    if limit is not None:
        raw_results = raw_results[:limit]

    parsed: list[SearchResult] = []
    for row in raw_results:
        # Pull known fields, stash the rest under `extra`.
        known = {"title", "url", "content", "engine", "score"}
        extra = {k: v for k, v in row.items() if k not in known}
        parsed.append(
            SearchResult(
                title=row.get("title", ""),
                url=row.get("url", ""),
                content=row.get("content", ""),
                engine=row.get("engine", ""),
                score=row.get("score"),
                extra=extra,
            )
        )

    return SearchResponse(
        query=data.get("query", query),
        number_of_results=data.get("number_of_results", len(parsed)),
        results=parsed,
    )
