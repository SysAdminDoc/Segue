# Changelog

All notable changes to Segue are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versioning is `vMAJOR.MINOR.PATCH`.

## [Unreleased]

### Added
- Transfer progress now streams over Server-Sent Events, including matching,
  review changes, resumed writes, completion, and errors. The browser keeps one
  same-origin event stream instead of polling the job endpoint every 1.5 seconds.
- Review now has bulk actions to include every medium-confidence match or exclude
  every unmatched row, plus a UTF-8 CSV download of unmatched tracks for manual
  handling. Active job IDs survive a tab reload in session storage.
- Spotify imports can now include saved albums and followed artists alongside
  playlists and liked songs. Each followed artist becomes a deduplicated catalog
  playlist assembled from their albums and singles because Spotify removed the
  top-tracks endpoint in February 2026. The OAuth path now requests
  `user-follow-read` and uses Spotify's renamed playlist `items` endpoint.
- Writes now reuse an owned YouTube Music playlist whose normalized title matches
  the source. Segue loads all existing video IDs, collapses duplicates within the
  reviewed source, appends only missing tracks, and reports added versus skipped
  counts without duplicating work after a checkpoint retry.
- Added a hosted bookmarklet installer for users who do not want a userscript
  manager. It generates a draggable bookmark from the current exporter source.
- Hardened the Pathfinder GraphQL fallback by capturing bodies from Fetch
  `Request` objects as well as `init.body`/XHR, and by supporting Spotify's
  batched GraphQL request shape before applying pagination.

### Fixed
- YouTube Music connections now survive server/container restarts. Segue keeps
  the signed browser session ID, reopens the newest saved OAuth or browser-header
  credential file, and falls back to the other auth method if the newest file is
  stale, allowing checkpointed write jobs to resume without reconnecting.

## [0.6.0] — 2026-07-28

Real fix for token capture: run in the page context.

### Fixed
- **The exporter wasn't capturing the token at all** in some Tampermonkey setups:
  v0.4/0.5 patched `unsafeWindow.fetch`, but `unsafeWindow` isn't always the real
  page window, so the hook silently missed the player's requests (diagnostic
  showed `token: no`). v0.6.0 runs the whole script **in the page context**
  (`@grant none` / `@inject-into page`), so `window.fetch` genuinely is the
  player's fetch — patching it always works, and the manager's page injection
  bypasses Spotify's CSP.
### Changed
- Dropped `GM_xmlhttpRequest`/`unsafeWindow`; all calls use plain `fetch`.
  Verified live that both `api.spotify.com` and Segue's import endpoint allow
  CORS from `open.spotify.com`, so no privileged APIs are needed. Pacing and the
  429 backoff from 0.5.0 are retained (browser can't read `Retry-After`, so it
  relies on proactive pacing + exponential backoff).

## [0.5.0] — 2026-07-28

Rate-limit-proof pacing for the exporter.

### Fixed
- The exporter fired paginated requests back-to-back with **no delay**, so large
  libraries tripped Spotify's ~180 req/min rolling-window limit and the playlist
  scan failed partway. Also fixed a latent crash reading the `Retry-After` header
  when it was absent.
### Changed
- All Spotify reads now go through a **paced queue**: one request at a time with a
  ~450ms gap (≈2.2 req/s ≈130/min), comfortably under the ceiling. On a 429 it
  backs off (honouring `Retry-After` when readable, else exponential 30→300s with
  jitter), **permanently slows the pace for the rest of the run**, and aborts
  cleanly rather than hammering into a multi-hour lockout if Spotify escalates.
  The log shows the pacing rate and any wait, so the slower speed reads as
  intentional. Applies to the pathfinder fallback too.

## [0.4.0] — 2026-07-28

Userscript actually captures the token now + live progress log.

### Fixed
- **The v0.3.0 page-context hook was blocked by Spotify's CSP** (injecting an
  inline `<script>` is refused), so the token was never captured. v0.4.0 patches
  the page's real `fetch`/`XHR` directly through **`unsafeWindow`** — no inline
  script, so CSP can't block it — and captures into a closure (no event bridge).
  Confirmed via live browser testing that Spotify's CSP blocks inline scripts and
  that the auth requests run on the main thread where the hook can see them.

### Added
- **Live verbose log** in the export dialog: timestamped lines for session
  capture, playlist discovery, and per-source song counts as they stream in, so a
  large library never looks frozen. Plus clearer status text and a persistent
  diagnostic line (token / client-token / liked-query).
- The dialog now opens immediately and reports progress while it waits for the
  session token and loads playlists (previously it could sit on a dead button).

## [0.3.0] — 2026-07-28

Fixed the userscript exporter — it now actually captures the token.

### Fixed
- **Token capture was broken two ways** (v0.2.0 never worked): (1) the `fetch`
  hook ran in the userscript's isolated sandbox, so it never patched the page's
  real `fetch`; (2) even in-page it failed to read the auth header off Spotify's
  `Request` objects. Now the hook is **injected into the page's main world** via a
  `<script>` element and relays the captured token back over a `CustomEvent`, and
  headers are read by normalizing every call through `new Request(input, init)`.
  Verified against the live player: bearer + `client-token` both captured.
### Added
- **Pathfinder GraphQL fallback**: if the REST library endpoints refuse the web
  token, Segue replays the player's own captured pathfinder request (v2) with
  pagination — its rotating query-hash is captured live, so it self-heals.
- **Diagnostic line** in the export dialog (token / client-token / pathfinder
  status) so failures are legible.
- All network calls now go through `GM_xmlhttpRequest` (no CORS friction);
  `@connect` for api.spotify.com and api-partner.spotify.com.

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

## Roadmap archive — 2026-08-10 — ROADMAP.md

<details>
<summary>Original roadmap snapshot</summary>

```markdown
# Roadmap

Open work only. Done items live in CHANGELOG.md.

## Next
- [ ] 🔧 Reverse direction: YouTube Music → Spotify (read YT library, write Spotify).
- [ ] 🤖 Persist per-session YT client across restarts (rehydrate from stored oauth.json) so resume works after a container restart, not just in-process.
- [ ] 🤖 Server-Sent Events for progress instead of 1.5s polling.
- [ ] 🤖 Bulk actions in review: "include all medium", "exclude all no-match".
- [ ] 🤖 Export unmatched tracks to CSV for manual handling.
- [ ] 🤖 Album + followed-artist sources (not just playlists + liked).
- [ ] 🔧 Redis-backed sessions/jobs to run more than one worker.
- [ ] 🤖 Dedup against an existing YT Music playlist (skip tracks already present).

## Watch
- [ ] 🤖 Userscript resilience — the web-player token capture and REST endpoints are unofficial; add a fallback to the pathfinder GraphQL endpoints if `/v1/me/tracks` starts 403-ing.
- [ ] 🤖 Bookmarklet variant of the exporter for users who won't install a userscript manager.
- [ ] 🤖 Host the userscript with a stable versioned URL + auto-update channel.
```

</details>
