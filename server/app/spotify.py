"""Spotify read-side client — Authorization Code + PKCE, library/playlist reads.

Reading a user's own playlists and saved tracks is NOT subject to a daily quota
(only a rolling ~30s rate window), so even a multi-thousand-track library reads
fine with light backoff. The Nov-2024 API cuts removed audio-features/
recommendations, not library reads.
"""
from __future__ import annotations

import base64
import hashlib
import secrets
import time
from typing import Any

import httpx

from .config import settings

AUTH_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
API = "https://api.spotify.com/v1"


def make_pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)[:96]
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).decode().rstrip("=")
    return verifier, challenge


def authorize_url(state: str, challenge: str) -> str:
    from urllib.parse import urlencode

    q = {
        "client_id": settings.spotify_client_id,
        "response_type": "code",
        "redirect_uri": settings.spotify_redirect_uri,
        "scope": settings.spotify_scopes,
        "state": state,
        "code_challenge_method": "S256",
        "code_challenge": challenge,
    }
    return f"{AUTH_URL}?{urlencode(q)}"


def exchange_code(code: str, verifier: str) -> dict[str, Any]:
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": settings.spotify_redirect_uri,
        "client_id": settings.spotify_client_id,
        "code_verifier": verifier,
    }
    if settings.spotify_client_secret:
        data["client_secret"] = settings.spotify_client_secret
    r = httpx.post(TOKEN_URL, data=data, timeout=30)
    r.raise_for_status()
    tok = r.json()
    tok["expires_at"] = time.time() + tok.get("expires_in", 3600) - 60
    return tok


def _refresh(tok: dict[str, Any]) -> dict[str, Any]:
    data = {
        "grant_type": "refresh_token",
        "refresh_token": tok["refresh_token"],
        "client_id": settings.spotify_client_id,
    }
    if settings.spotify_client_secret:
        data["client_secret"] = settings.spotify_client_secret
    r = httpx.post(TOKEN_URL, data=data, timeout=30)
    r.raise_for_status()
    new = r.json()
    tok["access_token"] = new["access_token"]
    tok["expires_at"] = time.time() + new.get("expires_in", 3600) - 60
    if new.get("refresh_token"):
        tok["refresh_token"] = new["refresh_token"]
    return tok


def _headers(tok: dict[str, Any]) -> dict[str, str]:
    if time.time() >= tok.get("expires_at", 0):
        _refresh(tok)
    return {"Authorization": f"Bearer {tok['access_token']}"}


def _get(tok: dict[str, Any], url: str, params: dict | None = None) -> dict[str, Any]:
    for attempt in range(6):
        r = httpx.get(url, headers=_headers(tok), params=params, timeout=30)
        if r.status_code == 429:
            time.sleep(int(r.headers.get("Retry-After", "2")) + 1)
            continue
        r.raise_for_status()
        return r.json()
    r.raise_for_status()
    return {}


def current_user(tok: dict[str, Any]) -> dict[str, Any]:
    return _get(tok, f"{API}/me")


def list_playlists(tok: dict[str, Any]) -> list[dict[str, Any]]:
    """All of the user's playlists as lightweight rows (id, name, total)."""
    out: list[dict[str, Any]] = []
    url: str | None = f"{API}/me/playlists"
    params: dict | None = {"limit": 50}
    while url:
        page = _get(tok, url, params)
        for pl in page.get("items", []):
            if not pl:
                continue
            out.append({
                "type": "playlist",
                "id": pl["id"],
                "name": pl["name"],
                "total": (pl.get("tracks") or {}).get("total", 0),
                "image": (pl.get("images") or [{}])[0].get("url"),
            })
        url = page.get("next")
        params = None
    return out


def liked_count(tok: dict[str, Any]) -> int:
    page = _get(tok, f"{API}/me/tracks", {"limit": 1})
    return page.get("total", 0)


def _norm_track(item: dict[str, Any]) -> dict[str, Any] | None:
    t = item.get("track") or item
    if not t or t.get("is_local") or not t.get("id"):
        return None
    return {
        "id": t["id"],
        "name": t.get("name", ""),
        "artists": [a["name"] for a in t.get("artists", [])],
        "album": (t.get("album") or {}).get("name", ""),
        "duration_ms": t.get("duration_ms", 0),
        "isrc": (t.get("external_ids") or {}).get("isrc"),
    }


def iter_playlist_tracks(tok: dict[str, Any], playlist_id: str):
    fields = "next,items(track(id,name,duration_ms,artists(name),album(name),external_ids(isrc),is_local))"
    url: str | None = f"{API}/playlists/{playlist_id}/tracks"
    params: dict | None = {"limit": 100, "fields": fields}
    while url:
        page = _get(tok, url, params)
        for item in page.get("items", []):
            nt = _norm_track(item)
            if nt:
                yield nt
        url = page.get("next")
        params = None


def iter_liked_tracks(tok: dict[str, Any]):
    url: str | None = f"{API}/me/tracks"
    params: dict | None = {"limit": 50}
    while url:
        page = _get(tok, url, params)
        for item in page.get("items", []):
            nt = _norm_track(item)
            if nt:
                yield nt
        url = page.get("next")
        params = None
