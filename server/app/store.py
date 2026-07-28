"""In-process session/job stores and a disk-backed match cache.

v0.1.0 keeps sessions and live YTMusic clients in memory (single process). Jobs
are additionally checkpointed to disk so a large migration survives a restart and
resumes without re-searching. Swap the dicts for Redis when scaling past one worker.
"""
from __future__ import annotations

import json
import threading
import uuid
from dataclasses import dataclass, field
from typing import Any

from .config import settings


@dataclass
class Session:
    sid: str
    spotify: dict[str, Any] | None = None      # tokens + expiry + code_verifier/state
    imported: dict[str, Any] | None = None     # library scraped by the browser userscript
    yt_client: Any | None = None               # live ytmusicapi.YTMusic instance
    yt_oauth_pending: dict[str, Any] | None = None  # device-flow handshake state
    yt_connected: bool = False

    @property
    def has_library(self) -> bool:
        return bool(self.imported) or bool(self.spotify and self.spotify.get("access_token"))


_sessions: dict[str, Session] = {}
_sessions_lock = threading.Lock()


def get_session(sid: str | None) -> Session:
    with _sessions_lock:
        if sid and sid in _sessions:
            return _sessions[sid]
        new_sid = uuid.uuid4().hex
        sess = Session(sid=new_sid)
        _sessions[new_sid] = sess
        return sess


# --------------------------------------------------------------------------- #
# Match cache — keyed by ISRC (fallback: normalized "artist|title"). Shared
# across sessions/jobs so a track matched once never gets searched again.
# --------------------------------------------------------------------------- #
_cache_path = settings.data_dir / "match_cache.json"
_cache_lock = threading.Lock()


def _load_cache() -> dict[str, Any]:
    if _cache_path.exists():
        try:
            return json.loads(_cache_path.read_text("utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


_match_cache: dict[str, Any] = _load_cache()


def cache_get(key: str) -> dict[str, Any] | None:
    with _cache_lock:
        return _match_cache.get(key)


def cache_put(key: str, value: dict[str, Any]) -> None:
    with _cache_lock:
        _match_cache[key] = value
        try:
            _cache_path.write_text(json.dumps(_match_cache), "utf-8")
        except OSError:
            pass


# --------------------------------------------------------------------------- #
# Imports — a library scraped by the browser userscript, POSTed here before the
# user's Segue session is known. Claimed into a session by import_id, then dropped.
# --------------------------------------------------------------------------- #
_imports: dict[str, Any] = {}
_imports_lock = threading.Lock()


def put_import(payload: dict[str, Any]) -> str:
    import_id = uuid.uuid4().hex
    with _imports_lock:
        _imports[import_id] = payload
    return import_id


def take_import(import_id: str) -> dict[str, Any] | None:
    with _imports_lock:
        return _imports.pop(import_id, None)


# --------------------------------------------------------------------------- #
# Jobs — a migration run. Checkpointed to disk after every phase transition and
# every committed add-batch so resume is cheap.
# --------------------------------------------------------------------------- #
_jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = threading.Lock()


def _job_path(job_id: str):
    return settings.data_dir / "jobs" / f"{job_id}.json"


def create_job(sid: str, sources: list[dict[str, Any]]) -> dict[str, Any]:
    job_id = uuid.uuid4().hex
    job = {
        "id": job_id,
        "sid": sid,
        "phase": "matching",          # matching -> review -> writing -> done -> error
        "sources": sources,            # [{type:'playlist'|'liked', id, name, total}]
        "matches": [],                 # per-track match rows (built during matching)
        "matched_count": 0,
        "total": sum(s.get("total", 0) for s in sources),
        "added_count": 0,
        "playlists_created": [],       # [{name, playlistId, url}]
        "error": None,
        "log": [],
    }
    with _jobs_lock:
        _jobs[job_id] = job
    save_job(job)
    return job


def get_job(job_id: str) -> dict[str, Any] | None:
    with _jobs_lock:
        if job_id in _jobs:
            return _jobs[job_id]
    p = _job_path(job_id)
    if p.exists():
        try:
            job = json.loads(p.read_text("utf-8"))
            with _jobs_lock:
                _jobs[job_id] = job
            return job
        except (json.JSONDecodeError, OSError):
            return None
    return None


def save_job(job: dict[str, Any]) -> None:
    try:
        _job_path(job["id"]).write_text(json.dumps(job), "utf-8")
    except OSError:
        pass
