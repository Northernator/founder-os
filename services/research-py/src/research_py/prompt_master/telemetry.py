"""
Telemetry sink for prompt-master events. Mirrors src/telemetry.ts.

Writes one JSON line per event to $PROMPT_MASTER_LOG_DIR/events.ndjson
(default ~/.founder-os/cache/prompt-master/events.ndjson). The TS CLI's
`prompt-master stats` command reads this same file, so both runtimes
contribute to a single rolling-window savings counter.

Disk writes are best-effort. A write failure logs to stderr and is swallowed
— telemetry must never break the actual optimization path.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _log_dir() -> Path:
    env = os.environ.get("PROMPT_MASTER_LOG_DIR")
    if env:
        return Path(env)
    return Path.home() / ".founder-os" / "cache" / "prompt-master"


def _log_file() -> Path:
    return _log_dir() / "events.ndjson"


_dir_ensured = False


def _ensure_dir() -> None:
    global _dir_ensured
    if _dir_ensured:
        return
    _log_file().parent.mkdir(parents=True, exist_ok=True)
    _dir_ensured = True


async def emit(event: dict[str, Any]) -> None:
    line = json.dumps({**event, "ts": datetime.now(timezone.utc).isoformat()})

    if os.environ.get("PROMPT_MASTER_VERBOSE") == "1":
        print(line, flush=True)

    try:
        _ensure_dir()
        # Sync write — these events are tiny and the asyncio overhead of a
        # thread offload is more than the actual fs write. If this becomes
        # hot, switch to aiofiles.
        with _log_file().open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError as exc:
        print(f"[prompt-master] telemetry write failed: {exc}", file=sys.stderr)


def get_log_file() -> Path:
    return _log_file()
