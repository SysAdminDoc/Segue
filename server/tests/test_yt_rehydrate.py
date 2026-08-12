from __future__ import annotations

import os
from pathlib import Path
import threading

import pytest
from fastapi.testclient import TestClient

from app import store, transfer, ytmusic
from app.main import app
from app.routes import COOKIE, _serializer


SID = "0123456789abcdef0123456789abcdef"


@pytest.fixture
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(ytmusic.settings, "data_dir", tmp_path)
    return tmp_path


def test_get_session_reuses_verified_cookie_id() -> None:
    store._sessions.clear()

    session = store.get_session(SID)

    assert session.sid == SID
    assert store.get_session(SID) is session


def test_status_rehydrates_saved_client_once(monkeypatch: pytest.MonkeyPatch) -> None:
    store._sessions.clear()
    client = object()
    calls: list[str] = []
    monkeypatch.setattr(
        ytmusic,
        "from_saved",
        lambda sid: calls.append(sid) or client,
    )
    with TestClient(app) as http:
        http.cookies.set(COOKIE, _serializer.dumps(SID))
        first = http.get("/api/status")
        second = http.get("/api/status")

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["ytmusic"] == {"connected": True}
    assert calls == [SID]


def test_from_saved_loads_oauth_with_configured_credentials(
    data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    oauth_path = data_dir / f"yt_oauth_{SID}.json"
    oauth_path.write_text("{}", encoding="utf-8")
    credentials = object()
    calls: list[tuple[str, object | None]] = []
    client = object()
    monkeypatch.setattr(ytmusic, "oauth_credentials", lambda: credentials)
    monkeypatch.setattr(
        ytmusic,
        "YTMusic",
        lambda path, oauth_credentials=None: calls.append((path, oauth_credentials)) or client,
    )

    assert ytmusic.from_saved(SID) is client
    assert calls == [(str(oauth_path), credentials)]


def test_from_saved_prefers_newest_auth_and_falls_back(
    data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    oauth_path = data_dir / f"yt_oauth_{SID}.json"
    headers_path = data_dir / f"yt_headers_{SID}.json"
    oauth_path.write_text("oauth", encoding="utf-8")
    headers_path.write_text("headers", encoding="utf-8")
    os.utime(oauth_path, (1, 1))
    os.utime(headers_path, (2, 2))
    client = object()
    calls: list[str] = []

    def load(path: str, oauth_credentials=None):
        calls.append(path)
        if path == str(headers_path):
            raise ValueError("stale headers")
        return client

    monkeypatch.setattr(ytmusic, "YTMusic", load)
    monkeypatch.setattr(ytmusic, "oauth_credentials", lambda: object())

    assert ytmusic.from_saved(SID) is client
    assert calls == [str(headers_path), str(oauth_path)]


def test_from_saved_rejects_unsafe_session_id(data_dir: Path) -> None:
    with pytest.raises(ValueError, match="Invalid session ID"):
        ytmusic.from_saved("../outside")


def test_resume_if_needed_starts_only_one_write_worker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    transfer._active_workers.clear()
    session = store.Session(sid=SID, yt_client=object(), yt_connected=True)
    job = {"id": "job-1", "phase": "writing"}
    started: list[tuple[str, store.Session]] = []
    entered = threading.Event()
    release = threading.Event()

    def commit(job_id: str, sess: store.Session) -> None:
        started.append((job_id, sess))
        entered.set()
        release.wait(timeout=1)

    monkeypatch.setattr(transfer, "get_job", lambda job_id: job)
    monkeypatch.setattr(transfer, "run_commit", commit)

    assert transfer.resume_if_needed("job-1", session) is True
    assert entered.wait(timeout=1)
    assert transfer.resume_if_needed("job-1", session) is False
    assert started == [("job-1", session)]
    release.set()
