# Segue

[![version](https://img.shields.io/badge/version-0.6.0-cba6f7)](https://github.com/SysAdminDoc/Segue/releases)
[![license](https://img.shields.io/badge/license-MIT-a6e3a1)](LICENSE)
[![stack](https://img.shields.io/badge/FastAPI%20%2B%20React-89b4fa)](#stack)
[![live](https://img.shields.io/badge/live-segue.getparkerai.com-fab387)](https://segue.getparkerai.com)

Migrate your **Spotify** playlists, liked songs, saved albums, and followed
artists to **YouTube Music** — with a match-review step so nothing lands on the
wrong track.

> **Live demo:** https://segue.getparkerai.com

## Why another one

Every incumbent (TuneMyMusic, Soundiiz, FreeYourMusic) matches poorly against
YouTube Music — its catalog blends official tracks, user uploads, live cuts and
music videos, so a naïve search drops you on the wrong version constantly
(TuneMyMusic showed a ~34% mismatch rate in testing). Segue makes **match review
the main event**: every track shows a confidence band, one-click alternates, and
a manual search — you approve before anything is written.

### No daily quota wall

The official **YouTube Data API v3** caps you at ~100 songs/day (search burns
100 of 10,000 daily units, and search is separately capped at 100/day). Segue
does **not** use it. It drives YouTube Music's internal web endpoints via
[`ytmusicapi`](https://github.com/sigma67/ytmusicapi) — the same requests the
browser makes — so search and playlist writes have **no daily unit quota**. A
multi-thousand-song library transfers in one run, paced politely to avoid soft
rate-limiting, and **checkpointed to disk** so it resumes if interrupted.

## How it works

1. **Import Spotify** — a small **browser userscript** exports your library. Spotify's
   Feb 2026 developer changes require **Premium** and cap Development Mode at **5
   users**, so Segue skips the Web API entirely: the userscript piggybacks on the
   Spotify **web player's** own auth token (which works for free accounts) to read
   your playlists and liked songs, then hands the list to Segue. No developer app,
   no Premium, no user cap. Your Spotify login never leaves your browser.
2. **Connect YouTube Music** — sign in with Google (device code) or paste browser headers.
3. **Choose** playlists, liked songs, saved albums, or followed artists to
   migrate. A followed artist becomes a deduplicated playlist of tracks from
   their albums and singles.
4. **Match** — Segue searches YT Music and scores each result (title + artist + duration).
5. **Review** — fix low-confidence matches, exclude junk, then commit.
6. **Transfer** — a same-name playlist in your YT Music library is reused and
   existing tracks are skipped; otherwise Segue creates it. Progress is
   checkpointed for safe resume.

> An **advanced OAuth path** (Spotify developer app, PKCE) is still built in for
> anyone with Premium who prefers it — but the userscript is the default and
> needs nothing from Spotify's developer program.

### The exporter userscript

Install [Tampermonkey](https://www.tampermonkey.net/) or
[Violentmonkey](https://violentmonkey.github.io/), then install the exporter from
**https://segue.getparkerai.com/segue-spotify.user.js**. On `open.spotify.com` it
adds an *"Export to YouTube Music"* button: pick playlists, albums, or followed
artists, and it scrapes them (paginated, rate-limit aware) and opens Segue with
your library loaded. Source:
[`web/public/segue-spotify.user.js`](web/public/segue-spotify.user.js).

## Stack

- **Backend:** Python 3.12, FastAPI, `ytmusicapi`, `rapidfuzz`, httpx (Spotify OAuth by hand).
- **Frontend:** React 18 + TypeScript + Vite, Catppuccin Mocha theme, no CSS framework.
- **Deploy:** single Docker image (SPA served by the API on one origin), behind Caddy.

## Run locally

```bash
# --- backend ---
cd server
python -m venv .venv && . .venv/Scripts/activate   # (Windows: .venv\Scripts\activate)
pip install -r requirements.txt
cp .env.example .env          # fill in Spotify + Google OAuth credentials
uvicorn app.main:app --reload --port 8000

# --- frontend (separate shell) ---
cd web
npm install
npm run dev                   # http://localhost:5173 (proxies /api → :8000)
```

You need:
- A **Spotify app** (developer.spotify.com/dashboard) with redirect URI
  `http://localhost:8000/api/auth/spotify/callback`.
- A **Google OAuth client**, type *"TVs and Limited Input devices"*, with the
  *YouTube Data API v3* enabled on the project.

## Docker

```bash
docker build -t segue .
docker run -p 8000:8000 --env-file server/.env -v segue-data:/app/data segue
# open http://localhost:8000
```

## Limits worth knowing

- **The userscript path sidesteps Spotify's developer limits entirely** (Premium
  requirement, 5-user Development Mode cap) because it uses your own web-player
  session, not the developer Web API. The only "limit" is Spotify's normal
  per-session rate window, which the script handles with backoff.
- Both the Spotify web-player scrape and the `ytmusicapi` write path are
  **unofficial** (web-client emulation). This is how the whole ecosystem operates;
  either can break if Spotify or YouTube changes its internal API.
- No YouTube Data API is used, so there is **no daily transfer quota**.

## License

MIT © Matthew Parker (SysAdminDoc)
