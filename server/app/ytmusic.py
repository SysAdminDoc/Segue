"""YouTube Music write-side client (unofficial, via ytmusicapi).

Crucially, ytmusicapi drives YouTube Music's *internal* web endpoints — the same
ones the browser calls — so search and playlist writes do NOT consume the
YouTube Data API v3 daily unit quota (~10k units/day). That is the whole reason
a large migration is feasible here where a Data-API build would stall at
~100 songs/day. Two auth paths:

  * oauth   — Google Cloud "TVs and Limited Input devices" client; clean consent.
  * headers — user pastes their logged-in request headers (power-user fallback).
"""
from __future__ import annotations

from pathlib import Path
import re
from typing import Any

import ytmusicapi
from ytmusicapi import YTMusic

try:  # import location differs across ytmusicapi minor versions
    from ytmusicapi.auth.oauth import OAuthCredentials, RefreshingToken
except ImportError:  # pragma: no cover
    from ytmusicapi.auth.oauth.credentials import OAuthCredentials  # type: ignore
    from ytmusicapi.auth.oauth.token import RefreshingToken  # type: ignore

from .config import settings

PLAYLIST_URL = "https://music.youtube.com/playlist?list={}"
_SID = re.compile(r"^[a-f0-9]{32}$")


def _auth_path(kind: str, sid: str) -> Path:
    if not _SID.fullmatch(sid):
        raise ValueError("Invalid session ID")
    return settings.data_dir / f"yt_{kind}_{sid}.json"


# --------------------------------------------------------------------------- #
# OAuth device flow
# --------------------------------------------------------------------------- #
def oauth_credentials() -> OAuthCredentials:
    if not settings.yt_oauth_client_id or not settings.yt_oauth_client_secret:
        raise RuntimeError("YT_OAUTH_CLIENT_ID / YT_OAUTH_CLIENT_SECRET not configured")
    return OAuthCredentials(
        client_id=settings.yt_oauth_client_id,
        client_secret=settings.yt_oauth_client_secret,
    )


def oauth_start() -> tuple[OAuthCredentials, dict[str, Any]]:
    """Request a device code. Returns (creds, {user_code, verification_url, ...})."""
    creds = oauth_credentials()
    code = creds.get_code()
    return creds, code


def oauth_poll(creds: OAuthCredentials, device_code: str, sid: str) -> YTMusic | None:
    """Attempt one token exchange. Returns a ready YTMusic client, or None if the
    user has not authorized yet."""
    try:
        raw = creds.token_from_code(device_code)
    except Exception:
        return None
    if not isinstance(raw, dict) or "access_token" not in raw:
        return None
    token = RefreshingToken(credentials=creds, **raw)
    path = _auth_path("oauth", sid)
    token.store_token(str(path))
    return YTMusic(str(path), oauth_credentials=creds)


# --------------------------------------------------------------------------- #
# Browser-headers fallback
# --------------------------------------------------------------------------- #
def from_headers(raw_headers: str, sid: str) -> YTMusic:
    auth_json = ytmusicapi.setup(headers_raw=raw_headers)
    path = _auth_path("headers", sid)
    path.write_text(auth_json, "utf-8")
    return YTMusic(str(path))


def from_saved(sid: str) -> YTMusic | None:
    """Reopen the newest valid credential file saved for a browser session.

    A user may switch auth methods, so modification time decides which account
    should win. If that file is corrupt or its OAuth client is no longer
    configured, the older credential is still attempted as a fallback.
    """
    paths = [
        (_auth_path("oauth", sid), "oauth"),
        (_auth_path("headers", sid), "headers"),
    ]
    existing = [(path, kind) for path, kind in paths if path.is_file()]
    def modified(item: tuple[Path, str]) -> float:
        try:
            return item[0].stat().st_mtime
        except OSError:
            return 0.0

    existing.sort(key=modified, reverse=True)
    for path, kind in existing:
        try:
            if kind == "oauth":
                return YTMusic(str(path), oauth_credentials=oauth_credentials())
            return YTMusic(str(path))
        except (OSError, ValueError, RuntimeError):
            continue
        except Exception:
            # ytmusicapi raises several format-specific exceptions for stale or
            # malformed credential files. Treat them as disconnected rather than
            # breaking every API request for the session.
            continue
    return None


# --------------------------------------------------------------------------- #
# Operations
# --------------------------------------------------------------------------- #
def search_songs(yt: YTMusic, query: str, limit: int = 5) -> list[dict[str, Any]]:
    try:
        results = yt.search(query, filter="songs", limit=limit, ignore_spelling=True)
    except Exception:
        return []
    out: list[dict[str, Any]] = []
    for r in results:
        vid = r.get("videoId")
        if not vid:
            continue
        out.append({
            "videoId": vid,
            "title": r.get("title", ""),
            "artists": [a.get("name", "") for a in (r.get("artists") or []) if a],
            "album": (r.get("album") or {}).get("name", "") if r.get("album") else "",
            "duration_seconds": r.get("duration_seconds") or 0,
        })
    return out


def create_playlist(yt: YTMusic, title: str, description: str = "") -> str:
    pid = yt.create_playlist(title, description or "Migrated by Segue", privacy_status="PRIVATE")
    if isinstance(pid, dict):  # error shape
        raise RuntimeError(f"create_playlist failed: {pid}")
    return pid


def add_items(yt: YTMusic, playlist_id: str, video_ids: list[str]) -> dict[str, Any]:
    return yt.add_playlist_items(playlist_id, video_ids, duplicates=True)
