"""Match a Spotify track to the best YouTube Music song.

YouTube Music is the worst-matching target of the major services (its catalog
mixes official tracks, user uploads, live cuts and music videos), so matching
quality is Segue's headline feature. We score candidates on title + artist
similarity and duration proximity, expose a confidence band, and always keep the
top alternates so the review UI can offer one-click rematch.
"""
from __future__ import annotations

import re
from typing import Any

from rapidfuzz import fuzz

_PAREN = re.compile(r"\s*[\(\[].*?[\)\]]\s*")
_FEAT = re.compile(r"\b(feat|ft|featuring|with)\b.*", re.IGNORECASE)
_NOISE = re.compile(r"\b(official|audio|video|lyrics?|remaster(ed)?|hd|4k|mv)\b", re.IGNORECASE)


def _norm(s: str) -> str:
    s = s.lower()
    s = _PAREN.sub(" ", s)
    s = _FEAT.sub(" ", s)
    s = _NOISE.sub(" ", s)
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def score(track: dict[str, Any], cand: dict[str, Any]) -> float:
    t_title = _norm(track["name"])
    c_title = _norm(cand["title"])
    title_score = fuzz.token_set_ratio(t_title, c_title)

    t_art = _norm(" ".join(track.get("artists", [])))
    c_art = _norm(" ".join(cand.get("artists", [])))
    art_score = fuzz.token_set_ratio(t_art, c_art) if t_art and c_art else 60.0

    # Duration proximity: full credit within 3s, decaying to 0 at 15s off.
    dur_score = 100.0
    t_sec = track.get("duration_ms", 0) / 1000.0
    c_sec = cand.get("duration_seconds", 0)
    if t_sec and c_sec:
        diff = abs(t_sec - c_sec)
        dur_score = max(0.0, 100.0 - max(0.0, diff - 3) * (100.0 / 12.0))

    return round(0.55 * title_score + 0.30 * art_score + 0.15 * dur_score, 1)


def band(confidence: float) -> str:
    if confidence >= 85:
        return "high"
    if confidence >= 68:
        return "medium"
    return "low"


def best_match(track: dict[str, Any], candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not candidates:
        return None
    ranked = sorted(candidates, key=lambda c: score(track, c), reverse=True)
    top = ranked[0]
    conf = score(track, top)
    return {
        "videoId": top["videoId"],
        "title": top["title"],
        "artists": top["artists"],
        "confidence": conf,
        "band": band(conf),
        "alternates": [
            {
                "videoId": c["videoId"],
                "title": c["title"],
                "artists": c["artists"],
                "confidence": score(track, c),
            }
            for c in ranked[:5]
        ],
    }
