"""Segue FastAPI entrypoint. Serves the JSON API and the built SPA on one origin."""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .routes import router

app = FastAPI(title="Segue", version=__version__)
app.include_router(router)

# Built frontend (web/dist) is copied to /app/web in the Docker image; in local
# dev it sits two levels up. Serve it as SPA fallback so client-side routes work.
_candidates = [Path("web"), Path(__file__).resolve().parents[2] / "web" / "dist"]
_web_dir = next((p for p in _candidates if p.exists()), None)

if _web_dir:
    assets = _web_dir / "assets"
    if assets.exists():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        candidate = _web_dir / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(_web_dir / "index.html")
