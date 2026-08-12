from __future__ import annotations

import csv
import io

from fastapi.testclient import TestClient

from app import store
from app.main import app
from app.routes import COOKIE, _serializer


SID = "11111111111111111111111111111111"
JOB_ID = "review-job"


def review_job() -> dict:
    return {
        "id": JOB_ID,
        "sid": SID,
        "phase": "review",
        "sources": [{"type": "playlist", "id": "p1", "name": "Road Trip", "total": 2}],
        "matches": [
            {
                "track": {"id": "medium", "name": "Almost", "artists": ["Artist A"], "album": "One", "duration_ms": 181000, "isrc": "A1"},
                "source_index": 0,
                "match": {"videoId": "v1", "band": "medium"},
                "status": "matched",
                "selected_videoId": "v1",
                "included": False,
            },
            {
                "track": {"id": "missing", "name": "Gone", "artists": ["Artist B", "Guest"], "album": "Two", "duration_ms": 200400, "isrc": None},
                "source_index": 0,
                "match": None,
                "status": "nomatch",
                "selected_videoId": None,
                "included": True,
            },
        ],
        "matched_count": 2,
        "total": 2,
        "added_count": 0,
        "playlists_created": [],
        "error": None,
        "log": [],
    }


def test_bulk_review_actions_and_unmatched_csv() -> None:
    job = review_job()
    store._sessions.clear()
    store._jobs[JOB_ID] = job
    try:
        with TestClient(app) as http:
            http.cookies.set(COOKIE, _serializer.dumps(SID))
            included = http.post(f"/api/transfer/{JOB_ID}/bulk", json={"action": "include_medium"})
            excluded = http.post(f"/api/transfer/{JOB_ID}/bulk", json={"action": "exclude_nomatch"})
            exported = http.get(f"/api/transfer/{JOB_ID}/unmatched.csv")

        assert included.json() == {"ok": True, "changed": 1}
        assert excluded.json() == {"ok": True, "changed": 1}
        assert job["matches"][0]["included"] is True
        assert job["matches"][1]["included"] is False
        assert exported.headers["content-disposition"] == 'attachment; filename="segue-unmatched.csv"'
        rows = list(csv.DictReader(io.StringIO(exported.content.decode("utf-8-sig"))))
        assert rows == [{
            "source": "Road Trip",
            "title": "Gone",
            "artists": "Artist B; Guest",
            "album": "Two",
            "duration_seconds": "200",
            "spotify_id": "missing",
            "isrc": "",
        }]
    finally:
        store._jobs.pop(JOB_ID, None)
