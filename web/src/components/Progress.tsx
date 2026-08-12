import { Job } from "../api";

export default function Progress({ job }: { job: Job }) {
  if (job.phase === "matching") {
    const pct = job.total ? Math.round((job.matched_count / job.total) * 100) : 0;
    return (
      <div className="card">
        <h2>Matching songs…</h2>
        <p className="hint">Searching YouTube Music for {job.total.toLocaleString()} tracks. You can leave this open.</p>
        <div className="bar"><span style={{ width: `${pct}%` }} /></div>
        <p className="muted">{job.matched_count.toLocaleString()} / {job.total.toLocaleString()} ({pct}%)</p>
      </div>
    );
  }

  if (job.phase === "writing") {
    const target = job.matches.filter(r => r.included).length;
    const handled = job.added_count + (job.skipped_count || 0);
    const pct = target ? Math.min(100, Math.round((handled / target) * 100)) : 0;
    return (
      <div className="card">
        <h2>Adding to YouTube Music…</h2>
        <div className="bar"><span style={{ width: `${pct}%` }} /></div>
        <p className="muted">
          {job.added_count.toLocaleString()} added · {(job.skipped_count || 0).toLocaleString()} already present / duplicate
        </p>
      </div>
    );
  }

  if (job.phase === "done") {
    return (
      <div className="card">
        <h2>✓ Migration complete</h2>
        <p className="hint">
          {job.added_count.toLocaleString()} songs added, {(job.skipped_count || 0).toLocaleString()} already present or duplicate,
          across {job.playlists_created.length} playlist(s).
        </p>
        <div className="done-links">
          {job.playlists_created.map(p => (
            <a key={`${p.playlistId}:${p.name}`} href={p.url} target="_blank" rel="noreferrer">
              ▶ {p.name}{p.reused ? " (existing)" : ""} — open in YouTube Music
            </a>
          ))}
        </div>
      </div>
    );
  }

  if (job.phase === "error") {
    return (
      <div className="card">
        <h2 style={{ color: "var(--red)" }}>Something went wrong</h2>
        <p className="err">{job.error}</p>
        <p className="muted">Progress is checkpointed — reconnect and re-run to resume where it stopped.</p>
      </div>
    );
  }
  return null;
}
