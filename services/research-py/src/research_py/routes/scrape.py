"""Scrape endpoint - thin wrapper over Firecrawl /v1/scrape.

POST /scrape with {url, formats?} returns the scraped content.
"""

from fastapi import APIRouter, HTTPException
import httpx

from research_py.clients import firecrawl

router = APIRouter(prefix="/scrape", tags=["scrape"])


@router.post("", response_model=firecrawl.ScrapeResponse)
async def scrape(req: firecrawl.ScrapeRequest) -> firecrawl.ScrapeResponse:
    try:
        return await firecrawl.scrape(req)
    except httpx.HTTPStatusError as e:
        # Surface Firecrawl's error body when it's something our caller can act on.
        raise HTTPException(
            status_code=e.response.status_code,
            detail=f"Firecrawl: {e.response.text[:500]}",
        ) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Firecrawl: {e}") from e
