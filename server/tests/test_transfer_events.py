from __future__ import annotations

import json

from fastapi.testclient import TestClient

from app import store
from app.main import app
from app.routes import COOKIE, _serializer


SID = "fedcba9876543210fedcba9876543210"


def test_done_job_streams_one_snapshot_and_closes() -> None:
    job_id = "event-job"
    job = {
        "id": job_id,
        "sid": SID,
        "phase": "done",
        "sources": [],
        "matches": [],
        "matched_count": 0,
        "total": 0,
        "added_count": 0,
        "playlists_created": [],
        "error": None,
        "log": [],
    }
    store._sessions.clear()
    store._jobs[job_id] = job
    try:
        with TestClient(app) as http:
            http.cookies.set(COOKIE, _serializer.dumps(SID))
            with http.stream("GET", f"/api/transfer/{job_id}/events") as response:
                lines = [line for line in response.iter_lines() if line]

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        assert response.headers["cache-control"] == "no-cache, no-transform"
        assert lines[0] == "retry: 2000"
        assert lines[1] == "event: job"
        assert json.loads(lines[2].removeprefix("data: ")) == job
    finally:
        store._jobs.pop(job_id, None)
