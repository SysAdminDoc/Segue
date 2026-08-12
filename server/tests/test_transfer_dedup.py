from __future__ import annotations

from app import store, transfer


SID = "44444444444444444444444444444444"


class FakeYTMusic:
    def __init__(self) -> None:
        self.added: list[list[str]] = []

    def get_library_playlists(self, limit=None):
        assert limit is None
        return [{"playlistId": "existing", "title": "Road Trip"}]

    def get_playlist(self, playlist_id, limit=None):
        assert playlist_id == "existing"
        assert limit is None
        return {"tracks": [{"videoId": "already"}]}

    def add_playlist_items(self, playlist_id, video_ids, duplicates=False):
        assert playlist_id == "existing"
        assert duplicates is False
        self.added.append(video_ids)
        return {"status": "STATUS_SUCCEEDED"}


def test_commit_reuses_same_name_playlist_and_skips_duplicates(monkeypatch) -> None:
    job_id = "dedup-job"
    job = {
        "id": job_id,
        "sid": SID,
        "phase": "review",
        "sources": [{"type": "playlist", "id": "p1", "name": "Road Trip", "total": 3}],
        "matches": [row("t1", "already"), row("t2", "new"), row("t3", "new")],
        "matched_count": 3,
        "total": 3,
        "added_count": 0,
        "skipped_count": 0,
        "playlists_created": [],
        "error": None,
        "log": [],
    }
    client = FakeYTMusic()
    store._jobs[job_id] = job
    monkeypatch.setattr(transfer.settings, "add_sleep_seconds", 0)
    try:
        transfer.run_commit(job_id, store.Session(sid=SID, yt_client=client, yt_connected=True))
    finally:
        store._jobs.pop(job_id, None)

    assert job["phase"] == "done"
    assert client.added == [["new"]]
    assert job["added_count"] == 1
    assert job["skipped_count"] == 2
    assert job["playlists_created"] == [{
        "source_index": 0,
        "name": "Road Trip",
        "playlistId": "existing",
        "url": "https://music.youtube.com/playlist?list=existing",
        "added": 1,
        "skipped": 2,
        "reused": True,
        "dedup_initialized": True,
    }]


def row(track_id: str, video_id: str) -> dict:
    return {
        "track": {"id": track_id},
        "source_index": 0,
        "match": {"videoId": video_id},
        "status": "matched",
        "selected_videoId": video_id,
        "included": True,
    }
