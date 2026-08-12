from __future__ import annotations

from fastapi.testclient import TestClient

from app import spotify, store
from app.main import app
from app.routes import COOKIE, _serializer


SID = "33333333333333333333333333333333"


def test_lists_saved_albums_and_followed_artists(monkeypatch) -> None:
    def get(_tok, url, params=None):
        if url.endswith("/me/albums"):
            return {
                "items": [{"album": {"id": "a1", "name": "Album", "artists": [{"name": "Artist"}], "total_tracks": 12, "images": []}}],
                "next": None,
            }
        if url.endswith("/me/following"):
            return {"artists": {"items": [{"id": "r1", "name": "Artist", "images": []}], "next": None}}
        raise AssertionError(url)

    monkeypatch.setattr(spotify, "_get", get)

    assert spotify.list_saved_albums({}) == [{
        "type": "album", "id": "a1", "name": "Album — Artist", "total": 12, "image": None,
    }]
    assert spotify.list_followed_artists({}) == [{
        "type": "artist", "id": "r1", "name": "Artist — catalog", "total": 0,
        "total_known": False, "image": None,
    }]


def test_followed_artist_catalog_deduplicates_releases_and_tracks(monkeypatch) -> None:
    def get(_tok, url, params=None):
        if url.endswith("/artists/r1/albums"):
            return {"items": [{"id": "a1"}, {"id": "a1"}, {"id": "a2"}], "next": None}
        if url.endswith("/albums/a1/tracks"):
            return {"items": [track("t1", "One"), track("shared", "Shared")], "next": None}
        if url.endswith("/albums/a2/tracks"):
            return {"items": [track("shared", "Shared"), track("t2", "Two")], "next": None}
        raise AssertionError(url)

    monkeypatch.setattr(spotify, "_get", get)

    assert [item["id"] for item in spotify.iter_artist_tracks({}, "r1")] == ["t1", "shared", "t2"]


def test_imported_library_exposes_album_and_artist_sources() -> None:
    imported = {
        "liked": None,
        "playlists": [],
        "albums": [{"id": "a1", "name": "Album — Artist", "tracks": [track("t1", "One")] }],
        "artists": [{"id": "r1", "name": "Artist — catalog", "tracks": [track("t2", "Two"), track("t3", "Three")] }],
    }
    store._sessions.clear()
    store._sessions[SID] = store.Session(sid=SID, imported=imported)

    with TestClient(app) as http:
        http.cookies.set(COOKIE, _serializer.dumps(SID))
        status = http.get("/api/status")
        sources = http.get("/api/playlists")

    assert status.json()["spotify"]["count"] == 3
    assert sources.json()["albums"] == [{"type": "album", "id": "a1", "name": "Album — Artist", "total": 1}]
    assert sources.json()["artists"] == [{"type": "artist", "id": "r1", "name": "Artist — catalog", "total": 2}]


def track(track_id: str, name: str) -> dict:
    return {
        "id": track_id,
        "name": name,
        "artists": [{"name": "Artist"}],
        "album": {"name": "Album"},
        "duration_ms": 180000,
        "external_ids": {"isrc": f"ISRC{track_id}"},
        "is_local": False,
    }
