"""Migration orchestration: match phase, then (after review) the write phase.

Everything routes through ytmusicapi's internal endpoints, so there is no daily
unit quota to exhaust — the only real limit is YouTube Music's soft rate
limiting, which we respect with configurable pacing. Both phases checkpoint to
disk after every unit of work, so a multi-thousand-track run resumes cleanly
after a restart and never re-searches a track it has already matched.
"""
from __future__ import annotations

import threading
import time
from typing import Any

from . import matcher, spotify, ytmusic
from .config import settings
from .store import Session, cache_get, cache_put, get_job, save_job


def _cache_key(track: dict[str, Any]) -> str:
    if track.get("isrc"):
        return f"isrc:{track['isrc']}"
    return "nt:" + matcher._norm(" ".join(track.get("artists", [])) + " " + track["name"])


def _iter_source_tracks(tok: dict[str, Any], source: dict[str, Any]):
    if source["type"] == "liked":
        yield from spotify.iter_liked_tracks(tok)
    else:
        yield from spotify.iter_playlist_tracks(tok, source["id"])


def run_match(job_id: str, sess: Session) -> None:
    job = get_job(job_id)
    if not job:
        return
    tok = sess.spotify
    yt = sess.yt_client
    try:
        for si, source in enumerate(job["sources"]):
            for track in _iter_source_tracks(tok, source):
                key = _cache_key(track)
                cached = cache_get(key)
                if cached is None:
                    query = f"{track['name']} {' '.join(track.get('artists', []))}".strip()
                    candidates = ytmusic.search_songs(yt, query, limit=5)
                    cache_put(key, {"candidates": candidates})
                    time.sleep(settings.match_sleep_seconds)
                else:
                    candidates = cached.get("candidates", [])

                match = matcher.best_match(track, candidates)
                job["matches"].append({
                    "track": track,
                    "source_index": si,
                    "match": match,
                    "status": "matched" if match else "nomatch",
                    "selected_videoId": match["videoId"] if match else None,
                    "included": bool(match),
                })
                job["matched_count"] += 1
                if job["matched_count"] % 20 == 0:
                    save_job(job)
        job["phase"] = "review"
    except Exception as exc:  # noqa: BLE001 — surface to the UI, don't crash the worker
        job["phase"] = "error"
        job["error"] = str(exc)
    save_job(job)


def start_match(job_id: str, sess: Session) -> None:
    threading.Thread(target=run_match, args=(job_id, sess), daemon=True).start()


def run_commit(job_id: str, sess: Session) -> None:
    job = get_job(job_id)
    if not job:
        return
    yt = sess.yt_client
    job["phase"] = "writing"
    save_job(job)
    try:
        # Group included, resolved matches by their source playlist.
        by_source: dict[int, list[str]] = {}
        for row in job["matches"]:
            if row["included"] and row.get("selected_videoId"):
                by_source.setdefault(row["source_index"], []).append(row["selected_videoId"])

        created = {p["source_index"]: p for p in job["playlists_created"]}
        for si, video_ids in by_source.items():
            source = job["sources"][si]
            name = "Liked Songs (Spotify)" if source["type"] == "liked" else source["name"]

            if si in created:
                pid = created[si]["playlistId"]
                start = created[si].get("added", 0)
            else:
                pid = ytmusic.create_playlist(yt, name)
                entry = {
                    "source_index": si,
                    "name": name,
                    "playlistId": pid,
                    "url": ytmusic.PLAYLIST_URL.format(pid),
                    "added": 0,
                }
                job["playlists_created"].append(entry)
                created[si] = entry
                start = 0
                save_job(job)

            batch = settings.add_batch_size
            for i in range(start, len(video_ids), batch):
                chunk = video_ids[i:i + batch]
                ytmusic.add_items(yt, pid, chunk)
                created[si]["added"] = i + len(chunk)
                job["added_count"] += len(chunk)
                save_job(job)
                time.sleep(settings.add_sleep_seconds)

        job["phase"] = "done"
    except Exception as exc:  # noqa: BLE001
        job["phase"] = "error"
        job["error"] = str(exc)
    save_job(job)


def start_commit(job_id: str, sess: Session) -> None:
    threading.Thread(target=run_commit, args=(job_id, sess), daemon=True).start()
