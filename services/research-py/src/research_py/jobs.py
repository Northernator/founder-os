"""In-memory job store for long-running research tasks.

Phase 2b scope: deep-research jobs run for 2-5 minutes; HTTP requests
shouldn't block that long. POST /research/deep enqueues a job and
returns 202 + job_id; GET /research/jobs/{id} returns the current
status / result.

State lives in a process-local dict guarded by an asyncio lock. That's
fine for a single-worker FastAPI deployment (see Dockerfile CMD - we
run uvicorn with one worker on purpose). When we move to multi-worker
or restart-survival, swap the backend for Redis or Postgres - the
JobStore interface should not have to change.

Persistence: none. A research-py restart loses in-flight jobs. The
output artifacts (research-summary.md / sources.json) DO survive,
because they're written to the bind-mounted ventures/ tree as the
job runs - so a restart loses status but not finished work.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field

log = logging.getLogger("research_py.jobs")

JobStatus = Literal["queued", "running", "done", "error"]
JobKind = Literal["deep_research", "competitor_scan", "icp_synthesis"]


class JobRecord(BaseModel):
    """The shape returned by GET /research/jobs/{id}."""

    job_id: str
    kind: JobKind
    status: JobStatus
    venture_slug: str
    created_at: datetime
    updated_at: datetime
    progress_message: str = Field(
        default="",
        description=(
            "Free-text status string. Currently set at major transitions "
            "(queued -> running -> done). Phase 2c may stream finer-grained "
            "progress events from GPT-Researcher's WebSocket callbacks."
        ),
    )
    result: dict[str, Any] | None = None
    error: str | None = None


class JobStore:
    """Singleton job store. Thread-safe via asyncio.Lock."""

    def __init__(self) -> None:
        self._jobs: dict[str, JobRecord] = {}
        self._lock = asyncio.Lock()

    async def create(self, kind: JobKind, venture_slug: str) -> JobRecord:
        now = datetime.now(timezone.utc)
        record = JobRecord(
            job_id=str(uuid.uuid4()),
            kind=kind,
            status="queued",
            venture_slug=venture_slug,
            created_at=now,
            updated_at=now,
            progress_message="queued",
        )
        async with self._lock:
            self._jobs[record.job_id] = record
        log.info("job created | id=%s | kind=%s | slug=%s", record.job_id, kind, venture_slug)
        return record

    async def get(self, job_id: str) -> JobRecord | None:
        async with self._lock:
            return self._jobs.get(job_id)

    async def update(
        self,
        job_id: str,
        *,
        status: JobStatus | None = None,
        progress_message: str | None = None,
        result: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> JobRecord | None:
        async with self._lock:
            record = self._jobs.get(job_id)
            if record is None:
                return None
            if status is not None:
                record.status = status
            if progress_message is not None:
                record.progress_message = progress_message
            if result is not None:
                record.result = result
            if error is not None:
                record.error = error
            record.updated_at = datetime.now(timezone.utc)
            self._jobs[job_id] = record
            return record

    async def list(self, *, kind: JobKind | None = None) -> list[JobRecord]:
        async with self._lock:
            records = list(self._jobs.values())
        if kind is not None:
            records = [r for r in records if r.kind == kind]
        # Newest first.
        records.sort(key=lambda r: r.created_at, reverse=True)
        return records


# Module-level singleton. Imported by routes.
job_store = JobStore()
