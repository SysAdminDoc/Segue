"""HTTP API. Session is a signed cookie; live clients live server-side per session."""
from __future__ import annotations

import secrets
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse
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
    return n + sum(len(p.get("tracks", [])) for p in imported.get("playlists", []))


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
    if not liked and not playlists:
        raise HTTPException(400, "Empty library payload")
    import_id = put_import({"liked": liked, "playlists": playlists})
    return JSONResponse(
        {"import_id": import_id, "count": _library_count({"liked": liked or {}, "playlists": playlists})},
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
        return {"liked": liked, "playlists": pls}
    tok = sess.spotify
    pls = spotify.list_playlists(tok)
    liked = {"type": "liked", "id": "liked", "name": "Liked Songs", "total": spotify.liked_count(tok)}
    return {"liked": liked, "playlists": pls}


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
