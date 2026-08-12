"""HTTP API. Session is a signed cookie; live clients live server-side per session."""
from __future__ import annotations

import asyncio
import csv
import io
import json
import secrets
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse
from itsdangerous import BadSignature, URLSafeSerializer

from . import spotify, transfer, ytmusic
from .config import settings
from .store import Session, get_job, get_session, put_import, save_job, take_import

# Origin the Spotify exporter userscript runs on (for CORS on the import endpoint).
IMPORT_ORIGIN = "https://open.spotify.com"

router = APIRouter(prefix="/api")
_serializer = URLSafeSerializer(settings.secret_key, salt="segue-sid")
COOKIE = "segue_sid"


def session_dep(request: Request, response: Response) -> Session:
    raw = request.cookies.get(COOKIE)
    sid = None
    if raw:
        try:
            sid = _serializer.loads(raw)
        except BadSignature:
            sid = None
    sess = get_session(sid)
    if not sess.yt_rehydrate_attempted:
        sess.yt_rehydrate_attempted = True
        sess.yt_client = ytmusic.from_saved(sess.sid)
        sess.yt_connected = sess.yt_client is not None
    response.set_cookie(
        COOKIE, _serializer.dumps(sess.sid),
        httponly=True, samesite="lax", max_age=60 * 60 * 24 * 7,
        secure=settings.public_base_url.startswith("https"),
    )
    return sess


@router.get("/health")
def health() -> dict[str, Any]:
    from . import __version__
    return {"status": "ok", "version": __version__}


def _library_count(imported: dict[str, Any]) -> int:
    n = len((imported.get("liked") or {}).get("tracks", []))
    for collection in ("playlists", "albums", "artists"):
        n += sum(len(source.get("tracks", [])) for source in imported.get(collection, []))
    return n


@router.get("/status")
def status(sess: Session = Depends(session_dep)) -> dict[str, Any]:
    user, source, count = None, None, 0
    if sess.imported:
        source, count = "import", _library_count(sess.imported)
    elif sess.spotify and sess.spotify.get("access_token"):
        source, user = "oauth", sess.spotify.get("user")
    return {
        "spotify": {"connected": sess.has_library, "user": user, "source": source, "count": count},
        "ytmusic": {"connected": sess.yt_connected},
    }


# --------------------------------------------------------------------------- #
# Browser userscript import (no Spotify developer app / Premium needed)
# --------------------------------------------------------------------------- #
@router.options("/import/spotify")
def import_preflight() -> Response:
    return Response(status_code=204, headers={
        "Access-Control-Allow-Origin": IMPORT_ORIGIN,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Max-Age": "86400",
    })


@router.post("/import/spotify")
def import_spotify(payload: dict[str, Any] = Body(...)) -> JSONResponse:
    """Receive a library scraped by the userscript. No session/cookie required —
    returns an import_id the SPA then claims into the visitor's session."""
    liked = payload.get("liked")
    playlists = payload.get("playlists", [])
    albums = payload.get("albums", [])
    artists = payload.get("artists", [])
    if not liked and not playlists and not albums and not artists:
        raise HTTPException(400, "Empty library payload")
    library = {"liked": liked, "playlists": playlists, "albums": albums, "artists": artists}
    import_id = put_import(library)
    return JSONResponse(
        {"import_id": import_id, "count": _library_count(library)},
        headers={"Access-Control-Allow-Origin": IMPORT_ORIGIN},
    )


@router.post("/import/claim")
def import_claim(import_id: str = Body(..., embed=True), sess: Session = Depends(session_dep)) -> dict[str, Any]:
    payload = take_import(import_id)
    if payload is None:
        raise HTTPException(404, "Import not found or already claimed")
    sess.imported = payload
    sess.spotify = None
    return {"ok": True, "count": _library_count(payload)}


# --------------------------------------------------------------------------- #
# Spotify OAuth (read side)
# --------------------------------------------------------------------------- #
@router.get("/auth/spotify/login")
def spotify_login(sess: Session = Depends(session_dep)) -> RedirectResponse:
    if not settings.spotify_client_id:
        raise HTTPException(500, "Spotify client not configured")
    verifier, challenge = spotify.make_pkce()
    state = secrets.token_urlsafe(16)
    sess.spotify = {"state": state, "code_verifier": verifier}
    return RedirectResponse(spotify.authorize_url(state, challenge))


@router.get("/auth/spotify/callback")
def spotify_callback(
    code: str | None = None, state: str | None = None, error: str | None = None,
    sess: Session = Depends(session_dep),
) -> RedirectResponse:
    if error or not code:
        return RedirectResponse(f"{settings.frontend_url}/?spotify=error")
    if not sess.spotify or sess.spotify.get("state") != state:
        return RedirectResponse(f"{settings.frontend_url}/?spotify=state_mismatch")
    tok = spotify.exchange_code(code, sess.spotify["code_verifier"])
    user = spotify.current_user(tok)
    tok["user"] = {"id": user.get("id"), "name": user.get("display_name")}
    sess.spotify = tok
    return RedirectResponse(f"{settings.frontend_url}/?spotify=connected")


# --------------------------------------------------------------------------- #
# YouTube Music auth (write side)
# --------------------------------------------------------------------------- #
@router.post("/auth/ytmusic/oauth/start")
def yt_oauth_start(sess: Session = Depends(session_dep)) -> dict[str, Any]:
    try:
        creds, code = ytmusic.oauth_start()
    except RuntimeError as exc:
        raise HTTPException(400, str(exc))
    sess.yt_oauth_pending = {"creds": creds, "device_code": code["device_code"]}
    return {
        "user_code": code["user_code"],
        "verification_url": code.get("verification_url") or code.get("verification_uri"),
        "interval": code.get("interval", 5),
        "expires_in": code.get("expires_in", 1800),
    }


@router.post("/auth/ytmusic/oauth/poll")
def yt_oauth_poll(sess: Session = Depends(session_dep)) -> dict[str, Any]:
    pending = sess.yt_oauth_pending
    if not pending:
        raise HTTPException(400, "No pending YouTube Music authorization")
    client = ytmusic.oauth_poll(pending["creds"], pending["device_code"], sess.sid)
    if client is None:
        return {"status": "pending"}
    sess.yt_client = client
    sess.yt_connected = True
    sess.yt_rehydrate_attempted = True
    sess.yt_oauth_pending = None
    return {"status": "connected"}


@router.post("/auth/ytmusic/headers")
def yt_headers(
    raw_headers: str = Body(..., embed=True), sess: Session = Depends(session_dep)
) -> dict[str, Any]:
    try:
        sess.yt_client = ytmusic.from_headers(raw_headers, sess.sid)
        sess.yt_connected = True
        sess.yt_rehydrate_attempted = True
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"Could not parse headers: {exc}")
    return {"status": "connected"}


# --------------------------------------------------------------------------- #
# Library + transfer
# --------------------------------------------------------------------------- #
def _require_library(sess: Session) -> None:
    if not sess.has_library:
        raise HTTPException(401, "No Spotify library connected")


@router.get("/playlists")
def playlists(sess: Session = Depends(session_dep)) -> dict[str, Any]:
    _require_library(sess)
    if sess.imported:
        liked_src = sess.imported.get("liked") or {}
        liked = {"type": "liked", "id": "liked", "name": liked_src.get("name", "Liked Songs"),
                 "total": len(liked_src.get("tracks", []))}
        pls = [{"type": "playlist", "id": p["id"], "name": p["name"], "total": len(p.get("tracks", []))}
               for p in sess.imported.get("playlists", [])]
        albums = [{"type": "album", "id": a["id"], "name": a["name"], "total": len(a.get("tracks", []))}
                  for a in sess.imported.get("albums", [])]
        artists = [{"type": "artist", "id": a["id"], "name": a["name"], "total": len(a.get("tracks", []))}
                   for a in sess.imported.get("artists", [])]
        return {"liked": liked, "playlists": pls, "albums": albums, "artists": artists}
    tok = sess.spotify
    pls = spotify.list_playlists(tok)
    albums = spotify.list_saved_albums(tok)
    artists = spotify.list_followed_artists(tok)
    liked = {"type": "liked", "id": "liked", "name": "Liked Songs", "total": spotify.liked_count(tok)}
    return {"liked": liked, "playlists": pls, "albums": albums, "artists": artists}


@router.post("/transfer")
def start_transfer(
    sources: list[dict[str, Any]] = Body(..., embed=True), sess: Session = Depends(session_dep)
) -> dict[str, Any]:
    _require_library(sess)
    if not sess.yt_connected or sess.yt_client is None:
        raise HTTPException(401, "YouTube Music not connected")
    if not sources:
        raise HTTPException(400, "No sources selected")
    from .store import create_job
    job = create_job(sess.sid, sources)
    transfer.start_match(job["id"], sess)
    return {"jobId": job["id"]}


def _owned_job(job_id: str, sess: Session) -> dict[str, Any]:
    job = get_job(job_id)
    if not job or job["sid"] != sess.sid:
        raise HTTPException(404, "Job not found")
    return job


@router.get("/transfer/{job_id}")
def transfer_status(job_id: str, sess: Session = Depends(session_dep)) -> dict[str, Any]:
    job = _owned_job(job_id, sess)
    transfer.resume_if_needed(job_id, sess)
    return job


@router.get("/transfer/{job_id}/events")
async def transfer_events(
    job_id: str, request: Request, sess: Session = Depends(session_dep)
) -> StreamingResponse:
    _owned_job(job_id, sess)

    async def stream():
        last_payload: str | None = None
        keepalive_ticks = 0
        yield "retry: 2000\n\n"
        while not await request.is_disconnected():
            job = get_job(job_id)
            if not job or job.get("sid") != sess.sid:
                break
            transfer.resume_if_needed(job_id, sess)
            payload = json.dumps(job, separators=(",", ":"), ensure_ascii=False)
            if payload != last_payload:
                yield f"event: job\ndata: {payload}\n\n"
                last_payload = payload
                keepalive_ticks = 0
                if job.get("phase") in ("done", "error"):
                    break
            else:
                keepalive_ticks += 1
                if keepalive_ticks >= 30:
                    yield ": keepalive\n\n"
                    keepalive_ticks = 0
            await asyncio.sleep(0.5)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/transfer/{job_id}/rematch")
def rematch(
    job_id: str,
    track_id: str = Body(...), video_id: str = Body(...),
    title: str = Body(""), artists: list[str] = Body(default_factory=list),
    sess: Session = Depends(session_dep),
) -> dict[str, Any]:
    job = _owned_job(job_id, sess)
    for row in job["matches"]:
        if row["track"]["id"] == track_id:
            row["selected_videoId"] = video_id
            row["included"] = True
            row["status"] = "matched"
            if row.get("match"):
                row["match"]["videoId"] = video_id
                if title:
                    row["match"]["title"] = title
                    row["match"]["artists"] = artists
            else:
                row["match"] = {"videoId": video_id, "title": title, "artists": artists,
                                "confidence": 100.0, "band": "manual", "alternates": []}
            save_job(job)
            return {"ok": True}
    raise HTTPException(404, "Track not in job")


@router.post("/transfer/{job_id}/toggle")
def toggle(
    job_id: str, track_id: str = Body(...), included: bool = Body(...),
    sess: Session = Depends(session_dep),
) -> dict[str, Any]:
    job = _owned_job(job_id, sess)
    for row in job["matches"]:
        if row["track"]["id"] == track_id:
            row["included"] = included
            save_job(job)
            return {"ok": True}
    raise HTTPException(404, "Track not in job")


@router.post("/transfer/{job_id}/bulk")
def bulk_update(
    job_id: str, action: str = Body(..., embed=True),
    sess: Session = Depends(session_dep),
) -> dict[str, Any]:
    job = _owned_job(job_id, sess)
    if job.get("phase") != "review":
        raise HTTPException(400, "Bulk actions are only available during review")
    if action == "include_medium":
        matches = lambda row: (row.get("match") or {}).get("band") == "medium"
        included = True
    elif action == "exclude_nomatch":
        matches = lambda row: row.get("status") == "nomatch"
        included = False
    else:
        raise HTTPException(400, "Unknown bulk action")

    changed = 0
    for row in job["matches"]:
        if matches(row) and row.get("included") != included:
            row["included"] = included
            changed += 1
    if changed:
        save_job(job)
    return {"ok": True, "changed": changed}


@router.get("/transfer/{job_id}/unmatched.csv")
def unmatched_csv(job_id: str, sess: Session = Depends(session_dep)) -> Response:
    job = _owned_job(job_id, sess)
    output = io.StringIO(newline="")
    fields = ["source", "title", "artists", "album", "duration_seconds", "spotify_id", "isrc"]
    writer = csv.DictWriter(output, fieldnames=fields)
    writer.writeheader()
    for row in job["matches"]:
        if row.get("status") != "nomatch":
            continue
        track = row["track"]
        source_index = row.get("source_index", -1)
        source = job["sources"][source_index] if 0 <= source_index < len(job["sources"]) else {}
        writer.writerow({
            "source": source.get("name", ""),
            "title": track.get("name", ""),
            "artists": "; ".join(track.get("artists", [])),
            "album": track.get("album", ""),
            "duration_seconds": round(track.get("duration_ms", 0) / 1000),
            "spotify_id": track.get("id", ""),
            "isrc": track.get("isrc", "") or "",
        })
    return Response(
        content="\ufeff" + output.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="segue-unmatched.csv"'},
    )


@router.post("/transfer/{job_id}/search")
def manual_search(
    job_id: str, query: str = Body(..., embed=True), sess: Session = Depends(session_dep)
) -> dict[str, Any]:
    _owned_job(job_id, sess)
    if sess.yt_client is None:
        raise HTTPException(401, "YouTube Music not connected")
    return {"results": ytmusic.search_songs(sess.yt_client, query, limit=8)}


@router.post("/transfer/{job_id}/commit")
def commit(job_id: str, sess: Session = Depends(session_dep)) -> dict[str, Any]:
    job = _owned_job(job_id, sess)
    if job["phase"] not in ("review", "error"):
        raise HTTPException(400, f"Job not ready to commit (phase={job['phase']})")
    if sess.yt_client is None:
        raise HTTPException(401, "YouTube Music not connected")
    transfer.start_commit(job_id, sess)
    return {"ok": True}
