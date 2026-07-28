# Changelog

All notable changes to Segue are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versioning is `vMAJOR.MINOR.PATCH`.

## [0.1.0] — 2026-07-28

Initial release.

### Added
- Spotify read-side: Authorization Code + PKCE OAuth, list playlists + liked
  songs, paginated track reads with 429 backoff and token refresh.
- YouTube Music write-side via `ytmusicapi` (internal endpoints — **no YouTube
  Data API daily quota**). Two auth paths: Google OAuth device flow and a
  browser-headers paste fallback.
- Matching engine (`rapidfuzz`): title + artist + duration scoring with
  high/medium/low confidence bands and ranked alternates.
- Match cache keyed by ISRC (fallback: normalized artist|title) — a track
  matched once is never searched again, across runs and users.
- Resumable transfers: match and write phases checkpoint to disk after every
  batch, so a large migration survives restarts.
- Review UI: confidence-banded table, one-click alternate rematch, manual YT
  Music search, per-track include/exclude, "needs attention" filter.
- Single-origin deploy: React SPA served by FastAPI in one Docker image.
- VPS deployment wiring for `segue.getparkerai.com` (Contabo, shared Caddy).
