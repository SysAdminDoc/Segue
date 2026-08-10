# Roadmap

Actionable work only. Historical and completed roadmap material is archived in CHANGELOG.md; blocked work is kept in Roadmap_Blocked.md.

## Actionable Items

- [ ] 🔧 Reverse direction: YouTube Music → Spotify (read YT library, write Spotify).

- [ ] 🤖 Persist per-session YT client across restarts (rehydrate from stored oauth.json) so resume works after a container restart, not just in-process.

- [ ] 🤖 Server-Sent Events for progress instead of 1.5s polling.

- [ ] 🤖 Bulk actions in review: "include all medium", "exclude all no-match".

- [ ] 🤖 Export unmatched tracks to CSV for manual handling.

- [ ] 🤖 Album + followed-artist sources (not just playlists + liked).

- [ ] 🔧 Redis-backed sessions/jobs to run more than one worker.

- [ ] 🤖 Dedup against an existing YT Music playlist (skip tracks already present).

- [ ] 🤖 Userscript resilience — the web-player token capture and REST endpoints are unofficial; add a fallback to the pathfinder GraphQL endpoints if `/v1/me/tracks` starts 403-ing.

- [ ] 🤖 Bookmarklet variant of the exporter for users who won't install a userscript manager.

- [ ] 🤖 Host the userscript with a stable versioned URL + auto-update channel.
