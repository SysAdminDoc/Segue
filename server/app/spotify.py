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
                "total": (pl.get("items") or pl.get("tracks") or {}).get("total", 0),
                "image": (pl.get("images") or [{}])[0].get("url"),
            })
        url = page.get("next")
        params = None
    return out


def list_saved_albums(tok: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    url: str | None = f"{API}/me/albums"
    params: dict | None = {"limit": 50}
    while url:
        page = _get(tok, url, params)
        for item in page.get("items", []):
            album = (item or {}).get("album") or {}
            if not album.get("id"):
                continue
            artists = [a.get("name", "") for a in album.get("artists", []) if a]
            label = f"{album.get('name', 'Untitled')} — {', '.join(artists)}" if artists else album.get("name", "Untitled")
            out.append({
                "type": "album",
                "id": album["id"],
                "name": label,
                "total": album.get("total_tracks") or (album.get("tracks") or {}).get("total", 0),
                "image": (album.get("images") or [{}])[0].get("url"),
            })
        url = page.get("next")
        params = None
    return out


def list_followed_artists(tok: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    url: str | None = f"{API}/me/following"
    params: dict | None = {"type": "artist", "limit": 50}
    while url:
        wrapper = _get(tok, url, params)
        page = wrapper.get("artists") or {}
        for artist in page.get("items", []):
            if not artist or not artist.get("id"):
                continue
            out.append({
                "type": "artist",
                "id": artist["id"],
                "name": f"{artist.get('name', 'Unknown artist')} — catalog",
                "total": 0,
                "total_known": False,
                "image": (artist.get("images") or [{}])[0].get("url"),
            })
        url = page.get("next")
        params = None
    return out


def liked_count(tok: dict[str, Any]) -> int:
    page = _get(tok, f"{API}/me/tracks", {"limit": 1})
    return page.get("total", 0)


def _norm_track(item: dict[str, Any]) -> dict[str, Any] | None:
    t = item.get("item") or item.get("track") or item
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
    url: str | None = f"{API}/playlists/{playlist_id}/items"
    params: dict | None = {"limit": 50}
    while url:
        page = _get(tok, url, params)
        for item in page.get("items", []):
            nt = _norm_track(item)
            if nt:
                yield nt
        url = page.get("next")
        params = None


def iter_album_tracks(tok: dict[str, Any], album_id: str):
    url: str | None = f"{API}/albums/{album_id}/tracks"
    params: dict | None = {"limit": 50}
    while url:
        page = _get(tok, url, params)
        for item in page.get("items", []):
            nt = _norm_track(item)
            if nt:
                yield nt
        url = page.get("next")
        params = None


def iter_artist_tracks(tok: dict[str, Any], artist_id: str):
    """Yield a followed artist's unique album/single tracks.

    Spotify removed the top-tracks endpoint in February 2026. Walking the
    artist's album and single releases is the supported catalog path.
    """
    album_ids: list[str] = []
    seen_albums: set[str] = set()
    url: str | None = f"{API}/artists/{artist_id}/albums"
    params: dict | None = {"include_groups": "album,single", "limit": 50}
    while url:
        page = _get(tok, url, params)
        for album in page.get("items", []):
            album_id = (album or {}).get("id")
            if album_id and album_id not in seen_albums:
                seen_albums.add(album_id)
                album_ids.append(album_id)
        url = page.get("next")
        params = None

    seen_tracks: set[str] = set()
    for album_id in album_ids:
        for track in iter_album_tracks(tok, album_id):
            if track["id"] not in seen_tracks:
                seen_tracks.add(track["id"])
                yield track


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
