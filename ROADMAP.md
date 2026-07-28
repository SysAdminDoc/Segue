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

## Blocked / policy
- [ ] ⛔ Public self-serve scale — requires Spotify extended quota (organization + ~250k MAU bar). Ships as a ≤25-user allowlisted tool until then.
