"""Search endpoint.

GET /search?q=...        - quick search, returns top results.
POST /search             - full search request body, more knobs.
"""

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from research_py.clients import searxng

router = APIRouter(prefix="/search", tags=["search"])


class SearchRequest(BaseModel):
    query: str
    categories: list[str] | None = None
    engines: list[str] | None = None
    language: str = "en"
    safesearch: int = Field(default=0, ge=0, le=2)
    pageno: int = Field(default=1, ge=1)
    limit: int | None = Field(default=20, ge=1, le=100)


@router.get("", response_model=searxng.SearchResponse)
async def search_get(
    q: str = Query(..., min_length=1),
    limit: int = Query(default=20, ge=1, le=100),
    language: str = Query(default="en"),
) -> searxng.SearchResponse:
    try:
        return await searxng.search(q, language=language, limit=limit)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"SearXNG: {e}") from e


@router.post("", response_model=searxng.SearchResponse)
async def search_post(req: SearchRequest) -> searxng.SearchResponse:
    try:
        return await searxng.search(
            req.query,
            categories=req.categories,
            engines=req.engines,
            language=req.language,
            safesearch=req.safesearch,
            pageno=req.pageno,
            limit=req.limit,
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"SearXNG: {e}") from e
