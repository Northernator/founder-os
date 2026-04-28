"""
Disk-backed LRU cache. Mirrors src/cache.ts.

Layout: $PROMPT_MASTER_CACHE_DIR/<first-2-of-hash>/<rest-of-hash>.json
Index:  $PROMPT_MASTER_CACHE_DIR/_index.json

Eviction: LRU with a configurable byte cap (default 200 MB), running
opportunistically on writes when totalBytes exceeds cap.

The index file is read+written for every put. That's fine at this scale
(thousands of entries, each KB-sized) and matches the TS implementation
exactly so both runtimes see the same cache state.
"""
from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, TypedDict

DEFAULT_MAX_BYTES = 200 * 1024 * 1024
INDEX_FILE = "_index.json"


class CachedEntry(TypedDict):
    optimized: str
    storedAt: str
    bytes: int


class IndexEntry(TypedDict):
    hash: str
    bytes: int
    lastUsed: str


class CacheIndex(TypedDict):
    totalBytes: int
    entries: list[IndexEntry]


def _cache_dir() -> Path:
    env = os.environ.get("PROMPT_MASTER_CACHE_DIR")
    if env:
        return Path(env)
    return Path.home() / ".founder-os" / "cache" / "prompt-master"


def _max_bytes() -> int:
    env = os.environ.get("PROMPT_MASTER_CACHE_MAX_BYTES")
    return int(env) if env else DEFAULT_MAX_BYTES


def _path_for(hash_: str) -> Path:
    return _cache_dir() / hash_[:2] / (hash_[2:] + ".json")


def _index_path() -> Path:
    return _cache_dir() / INDEX_FILE


def _read_index() -> CacheIndex:
    try:
        with _index_path().open("r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {"totalBytes": 0, "entries": []}


def _write_index(index: CacheIndex) -> None:
    _index_path().parent.mkdir(parents=True, exist_ok=True)
    with _index_path().open("w", encoding="utf-8") as f:
        json.dump(index, f)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def get_cached(hash_: str) -> Optional[CachedEntry]:
    return await asyncio.to_thread(_get_cached_sync, hash_)


def _get_cached_sync(hash_: str) -> Optional[CachedEntry]:
    try:
        with _path_for(hash_).open("r", encoding="utf-8") as f:
            entry: CachedEntry = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    # Touch index — record this hit as a recent access.
    index = _read_index()
    for e in index["entries"]:
        if e["hash"] == hash_:
            e["lastUsed"] = _now_iso()
            _write_index(index)
            break
    return entry


async def put_cached(hash_: str, optimized: str) -> None:
    await asyncio.to_thread(_put_cached_sync, hash_, optimized)


def _put_cached_sync(hash_: str, optimized: str) -> None:
    entry: CachedEntry = {
        "optimized": optimized,
        "storedAt": _now_iso(),
        "bytes": len(optimized.encode("utf-8")),
    }
    file = _path_for(hash_)
    file.parent.mkdir(parents=True, exist_ok=True)
    with file.open("w", encoding="utf-8") as f:
        json.dump(entry, f)

    index = _read_index()
    existing = next((e for e in index["entries"] if e["hash"] == hash_), None)
    if existing:
        index["totalBytes"] -= existing["bytes"]
        existing["bytes"] = entry["bytes"]
        existing["lastUsed"] = entry["storedAt"]
        index["totalBytes"] += entry["bytes"]
    else:
        index["entries"].append(
            {"hash": hash_, "bytes": entry["bytes"], "lastUsed": entry["storedAt"]}
        )
        index["totalBytes"] += entry["bytes"]

    _evict_if_needed(index)
    _write_index(index)


def _evict_if_needed(index: CacheIndex) -> None:
    cap = _max_bytes()
    if index["totalBytes"] <= cap:
        return
    # Evict least-recently-used until under cap.
    index["entries"].sort(key=lambda e: e["lastUsed"])
    while index["totalBytes"] > cap and index["entries"]:
        victim = index["entries"].pop(0)
        try:
            _path_for(victim["hash"]).unlink()
        except OSError:
            pass
        index["totalBytes"] -= victim["bytes"]


async def inspect_cache() -> dict:
    index = await asyncio.to_thread(_read_index)
    return {
        "entries": len(index["entries"]),
        "totalBytes": index["totalBytes"],
        "capBytes": _max_bytes(),
    }
