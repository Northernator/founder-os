"""Research endpoints.

Phase 2b: /research/deep is wired through GPT-Researcher. Returns
202 + job_id and runs the job in an asyncio task. Poll
GET /research/jobs/{id} for status.

Phase 2c-competitors: /research/competitors is wired through Crawl4AI +
ScrapeGraphAI. Same async-job pattern. Writes per-competitor markdown
under 01_research/competitors/{slug}/ and a unified
02_validation/pricing/competitors-pricing.csv.

Phase 2c-icp stub (still 501): /research/icp.
"""

from __future__ import annotations

import asyncio
import csv
import json
import logging
import re
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from research_py.competitors import (
    CSV_FIELDS,
    CompetitorScanResult,
    scan_competitor,
)
from research_py.config import settings
from research_py.jobs import JobRecord, job_store

log = logging.getLogger("research_py.routes.research")

router = APIRouter(prefix="/research", tags=["research"])


# ----------------------------- shared helpers -----------------------------

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def _validate_slug(slug: str) -> None:
    """Defensive check - the slug is used as a directory name."""
    if not _SLUG_RE.match(slug):
        raise HTTPException(
            status_code=400,
            detail=(
                f"venture_slug={slug!r} must be lowercase alnum with - or _, "
                "1-64 chars, starting with a letter or digit."
            ),
        )


# ----------------------------- /research/deep -----------------------------

class DeepResearchRequest(BaseModel):
    venture_slug: str = Field(..., description="Folder under ventures/ to write into")
    topic: str = Field(..., description="What to research")
    depth: int = Field(default=3, ge=1, le=5)
    report_type: str = Field(default="research_report")


class DeepResearchAcceptedResponse(BaseModel):
    job_id: str
    status: str
    venture_slug: str
    poll: str = Field(description="GET this URL to poll job status")


def _deep_output_dir(slug: str) -> Path:
    return settings.ventures_dir / slug / "01_research" / "market-gaps"


@router.post(
    "/deep",
    response_model=DeepResearchAcceptedResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def deep_research(req: DeepResearchRequest) -> DeepResearchAcceptedResponse:
    """Kick off a deep-research job. Returns immediately with a job_id."""
    _validate_slug(req.venture_slug)

    record = await job_store.create(
        kind="deep_research",
        venture_slug=req.venture_slug,
    )

    asyncio.create_task(_run_deep_research(record.job_id, req))

    return DeepResearchAcceptedResponse(
        job_id=record.job_id,
        status=record.status,
        venture_slug=record.venture_slug,
        poll=f"/research/jobs/{record.job_id}",
    )


async def _run_deep_research(job_id: str, req: DeepResearchRequest) -> None:
    try:
        await job_store.update(
            job_id, status="running", progress_message="initialising GPTResearcher"
        )
        from gpt_researcher import GPTResearcher  # type: ignore[import-not-found]

        report_type = "deep" if req.depth >= 4 else req.report_type
        researcher = GPTResearcher(query=req.topic, report_type=report_type)

        await job_store.update(job_id, progress_message="conducting research (search + scrape phase)")
        await researcher.conduct_research()

        await job_store.update(job_id, progress_message="writing report")
        report_md: str = await researcher.write_report()

        sources: list[str] = _extract_sources(researcher)

        out_dir = _deep_output_dir(req.venture_slug)
        out_dir.mkdir(parents=True, exist_ok=True)
        summary_path = out_dir / "research-summary.md"
        sources_path = out_dir / "sources.json"

        summary_path.write_text(report_md, encoding="utf-8")
        sources_path.write_text(
            json.dumps(
                {
                    "topic": req.topic,
                    "depth": req.depth,
                    "report_type": report_type,
                    "sources": sources,
                },
                indent=2,
            ),
            encoding="utf-8",
        )

        await job_store.update(
            job_id,
            status="done",
            progress_message="done",
            result={
                "venture_slug": req.venture_slug,
                "output_path": str(summary_path),
                "sources_path": str(sources_path),
                "summary_md_chars": len(report_md),
                "sources_count": len(sources),
                "sources": sources,
            },
        )
        log.info(
            "deep_research done | job=%s | slug=%s | chars=%d | sources=%d",
            job_id, req.venture_slug, len(report_md), len(sources),
        )

    except Exception as exc:  # noqa: BLE001
        log.exception("deep_research failed | job=%s", job_id)
        await job_store.update(
            job_id,
            status="error",
            progress_message="error",
            error=f"{type(exc).__name__}: {exc}",
        )


def _extract_sources(researcher: Any) -> list[str]:
    candidates = ("research_sources", "visited_urls", "source_urls", "sources")
    for name in candidates:
        val = getattr(researcher, name, None)
        if not val:
            continue
        if isinstance(val, (set, frozenset)):
            return sorted(str(u) for u in val)
        if isinstance(val, list):
            out: list[str] = []
            for item in val:
                if isinstance(item, str):
                    out.append(item)
                elif isinstance(item, dict) and "url" in item:
                    out.append(str(item["url"]))
            if out:
                return out
    return []


# ------------------------- /research/competitors --------------------------

class CompetitorScanRequest(BaseModel):
    venture_slug: str = Field(..., description="Folder under ventures/ to write into")
    urls: list[str] = Field(..., min_length=1, max_length=20)


class CompetitorScanAcceptedResponse(BaseModel):
    job_id: str
    status: str
    venture_slug: str
    poll: str
    competitor_count: int


@router.post(
    "/competitors",
    response_model=CompetitorScanAcceptedResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def competitor_scan(req: CompetitorScanRequest) -> CompetitorScanAcceptedResponse:
    """Kick off a competitor scan. Returns immediately with a job_id."""
    _validate_slug(req.venture_slug)

    record = await job_store.create(
        kind="competitor_scan",
        venture_slug=req.venture_slug,
    )
    asyncio.create_task(_run_competitor_scan(record.job_id, req))

    return CompetitorScanAcceptedResponse(
        job_id=record.job_id,
        status=record.status,
        venture_slug=record.venture_slug,
        poll=f"/research/jobs/{record.job_id}",
        competitor_count=len(req.urls),
    )


def _competitor_dir(slug: str, competitor_slug: str) -> Path:
    return settings.ventures_dir / slug / "01_research" / "competitors" / competitor_slug


def _pricing_csv_path(slug: str) -> Path:
    return settings.ventures_dir / slug / "02_validation" / "pricing" / "competitors-pricing.csv"


async def _run_competitor_scan(job_id: str, req: CompetitorScanRequest) -> None:
    try:
        await job_store.update(
            job_id, status="running",
            progress_message=f"scanning {len(req.urls)} competitor(s)",
        )

        results: list[CompetitorScanResult] = await asyncio.gather(
            *(scan_competitor(url) for url in req.urls),
            return_exceptions=False,
        )

        await job_store.update(job_id, progress_message="writing per-competitor artifacts")

        per_competitor: list[dict[str, Any]] = []
        for result in results:
            comp_dir = _competitor_dir(req.venture_slug, result.slug)
            comp_dir.mkdir(parents=True, exist_ok=True)

            if result.landing_md is not None:
                (comp_dir / "landing.md").write_text(result.landing_md, encoding="utf-8")
            if result.pricing_md is not None:
                (comp_dir / "pricing.md").write_text(result.pricing_md, encoding="utf-8")
            if result.about_md is not None:
                (comp_dir / "about.md").write_text(result.about_md, encoding="utf-8")

            (comp_dir / "pricing-plans.json").write_text(
                json.dumps(
                    {
                        "competitor_url": result.url,
                        "competitor_slug": result.slug,
                        "pricing_url": result.pages.pricing,
                        "plans": [p.model_dump() for p in result.pricing_plans],
                        "errors": result.errors,
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )

            per_competitor.append(
                {
                    "url": result.url,
                    "slug": result.slug,
                    "landing": result.pages.landing,
                    "pricing": result.pages.pricing,
                    "about": result.pages.about,
                    "wrote_landing": result.landing_md is not None,
                    "wrote_pricing": result.pricing_md is not None,
                    "wrote_about": result.about_md is not None,
                    "pricing_rows": len(result.pricing_plans),
                    "errors": result.errors,
                }
            )

        await job_store.update(job_id, progress_message="merging pricing CSV")

        csv_path = _pricing_csv_path(req.venture_slug)
        csv_path.parent.mkdir(parents=True, exist_ok=True)
        with csv_path.open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
            writer.writeheader()
            for result in results:
                for plan in result.pricing_plans:
                    writer.writerow(
                        {
                            "competitor": result.slug,
                            "plan_name": plan.plan_name,
                            "billing_period": plan.billing_period,
                            "price_monthly": "" if plan.price_monthly is None else plan.price_monthly,
                            "price_annual": "" if plan.price_annual is None else plan.price_annual,
                            "currency": plan.currency or "",
                            "included_features": "|".join(plan.included_features),
                            "cta_text": plan.cta_text or "",
                            "target_segment": plan.target_segment or "",
                            "source_url": result.pages.pricing or "",
                        }
                    )

        await job_store.update(
            job_id,
            status="done",
            progress_message="done",
            result={
                "venture_slug": req.venture_slug,
                "competitor_count": len(results),
                "competitors": per_competitor,
                "pricing_csv": str(csv_path),
                "pricing_rows_total": sum(len(r.pricing_plans) for r in results),
            },
        )
        log.info(
            "competitor_scan done | job=%s | slug=%s | competitors=%d | pricing_rows=%d",
            job_id, req.venture_slug, len(results),
            sum(len(r.pricing_plans) for r in results),
        )

    except Exception as exc:  # noqa: BLE001
        log.exception("competitor_scan failed | job=%s", job_id)
        await job_store.update(
            job_id,
            status="error",
            progress_message="error",
            error=f"{type(exc).__name__}: {exc}",
        )


# ------------------------------ /research/icp -----------------------------

class IcpRequest(BaseModel):
    venture_slug: str


@router.post("/icp", response_model=dict)
async def synthesize_icp(req: IcpRequest) -> dict:
    raise HTTPException(
        status_code=501,
        detail="Phase 2c-icp - pydantic-ai ICP agent not yet wired.",
    )


# ------------------------------ /research/jobs ----------------------------

class JobListResponse(BaseModel):
    jobs: list[JobRecord]


@router.get("/jobs/{job_id}", response_model=JobRecord)
async def get_job(job_id: str) -> JobRecord:
    record = await job_store.get(job_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"job {job_id} not found")
    return record


@router.get("/jobs", response_model=JobListResponse)
async def list_jobs() -> JobListResponse:
    return JobListResponse(jobs=await job_store.list())
