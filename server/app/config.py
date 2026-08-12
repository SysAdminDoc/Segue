"""Runtime configuration, loaded from environment / .env."""
from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # --- Session signing ---
    secret_key: str = "change-me-in-production"

    # --- Public URLs ---
    # Origin the browser hits. Same origin serves API + built frontend on the VPS.
    public_base_url: str = "http://localhost:8000"
    # Where to bounce the browser back to after an OAuth round-trip (the SPA).
    frontend_url: str = "http://localhost:5173"

    # --- Spotify (read side) ---
    spotify_client_id: str = ""
    spotify_client_secret: str = ""  # optional; PKCE works without it
    spotify_scopes: str = "playlist-read-private playlist-read-collaborative user-library-read user-follow-read"

    # --- YouTube Music (write side) ---
    # Google Cloud OAuth client of type "TVs and Limited Input devices" with the
    # YouTube Data API enabled. Calls still route through ytmusicapi's internal
    # endpoints (no daily unit quota) — this client only authorizes the session.
    yt_oauth_client_id: str = ""
    yt_oauth_client_secret: str = ""

    # --- Transfer pacing (protects against YT Music soft rate-limiting) ---
    # Seconds to sleep between search calls during matching.
    match_sleep_seconds: float = 0.3
    # How many videoIds to push per add_playlist_items call.
    add_batch_size: int = 100
    # Seconds to sleep between add batches.
    add_sleep_seconds: float = 1.0

    # --- Storage ---
    data_dir: Path = Path("data")

    @property
    def spotify_redirect_uri(self) -> str:
        return f"{self.public_base_url}/api/auth/spotify/callback"


settings = Settings()
settings.data_dir.mkdir(parents=True, exist_ok=True)
(settings.data_dir / "jobs").mkdir(parents=True, exist_ok=True)
