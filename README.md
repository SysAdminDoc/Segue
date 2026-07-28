# Segue

[![version](https://img.shields.io/badge/version-0.1.0-cba6f7)](https://github.com/SysAdminDoc/Segue/releases)
[![license](https://img.shields.io/badge/license-MIT-a6e3a1)](LICENSE)
[![stack](https://img.shields.io/badge/FastAPI%20%2B%20React-89b4fa)](#stack)
[![live](https://img.shields.io/badge/live-segue.getparkerai.com-fab387)](https://segue.getparkerai.com)

Migrate your **Spotify** playlists and liked songs to **YouTube Music** — with a
match-review step so nothing lands on the wrong track.

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

1. **Connect Spotify** (read-only: playlists + liked songs, OAuth PKCE).
2. **Connect YouTube Music** — sign in with Google (device code) or paste browser headers.
3. **Choose** playlists / liked songs to migrate.
4. **Match** — Segue searches YT Music and scores each result (title + artist + duration).
5. **Review** — fix low-confidence matches, exclude junk, then commit.
6. **Transfer** — playlists are created in your YT Music account with progress + resume.

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

- **Spotify keeps new apps in development mode (25 authorized users).** Segue is
  fully functional for you and up to 25 people you allowlist; a public self-serve
  service requires Spotify "extended quota," which is granted to organizations
  only. This is a Spotify policy limit, not a Segue one.
- The `ytmusicapi` path is **unofficial** (web-client emulation). It's how the
  whole ecosystem does YT Music writes at scale; it can break if YouTube changes
  its internal API.

## License

MIT © Matthew Parker (SysAdminDoc)
