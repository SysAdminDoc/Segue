# Changelog

All notable changes to Segue are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versioning is `vMAJOR.MINOR.PATCH`.

## [0.2.0] — 2026-07-28

Browser-userscript import — no Spotify developer app or Premium required.

### Added
- **Spotify exporter userscript** (`web/public/segue-spotify.user.js`, served at
  `/segue-spotify.user.js`): hooks the web player's own bearer token, lets the
  user pick sources, scrapes playlists + liked songs (paginated, 429-aware), and
  POSTs the library to Segue via `GM_xmlhttpRequest`.
- Backend import flow: `POST /api/import/spotify` (CORS for open.spotify.com,
  no cookie) returns an `import_id`; `POST /api/import/claim` binds that library
  into the visitor's session. Transfer/matching read from the imported library
  when present, otherwise from the Spotify Web API.
- Frontend claims `/#import=<id>` on load; Connect screen now leads with the
  userscript install steps, with the OAuth app path demoted to "advanced".

### Changed
- Spotify OAuth (developer app) is now optional/secondary — Spotify's Feb 2026
  changes require Premium and cap Development Mode at 5 users, making the
  userscript the primary path.

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
