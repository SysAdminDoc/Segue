import { useMemo, useState } from "react";
import { api, Candidate, Job, Row } from "../api";

function confClass(row: Row) {
  if (row.status === "nomatch") return "nomatch";
  return row.match?.band || "medium";
}

function RowActions({ jobId, row, refresh }: { jobId: string; row: Row; refresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(`${row.track.name} ${row.track.artists.join(" ")}`);
  const [results, setResults] = useState<Candidate[]>([]);
  const [searching, setSearching] = useState(false);

  async function pick(c: Candidate) {
    await api.rematch(jobId, row.track.id, c.videoId, c.title, c.artists);
    setOpen(false); refresh();
  }
  async function runSearch() {
    setSearching(true);
    try { const r = await api.search(jobId, q); setResults(r.results); }
    finally { setSearching(false); }
  }

  return (
    <>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {row.match && row.match.alternates.length > 1 && (
          <select
            value={row.selected_videoId || ""}
            onChange={e => {
              const alt = row.match!.alternates.find(a => a.videoId === e.target.value);
              if (alt) pick(alt);
            }}
          >
            {row.match.alternates.map(a => (
              <option key={a.videoId} value={a.videoId}>
                {a.title} — {a.artists.join(", ")} ({a.confidence})
              </option>
            ))}
          </select>
        )}
        <button className="btn ghost sm" onClick={() => setOpen(o => !o)}>Search</button>
        <button className="btn ghost sm" onClick={() => api.toggle(jobId, row.track.id, !row.included).then(refresh)}>
          {row.included ? "Exclude" : "Include"}
        </button>
      </div>
      {open && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: "flex", gap: 6 }}>
            <input type="text" value={q} onChange={e => setQ(e.target.value)} />
            <button className="btn ghost sm" disabled={searching} onClick={runSearch}>Go</button>
          </div>
          {results.map(c => (
            <div className="item" key={c.videoId}>
              <span className="name">{c.title} — {c.artists.join(", ")}</span>
              <button className="btn primary sm" onClick={() => pick(c)}>Use</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export default function Review({ job, refresh, onCommit }: { job: Job; refresh: () => void; onCommit: () => void }) {
  const [showAll, setShowAll] = useState(false);
  const [committing, setCommitting] = useState(false);

  const stats = useMemo(() => {
    let high = 0, mid = 0, low = 0, none = 0, included = 0;
    for (const r of job.matches) {
      if (r.included) included++;
      if (r.status === "nomatch") none++;
      else if (r.match?.band === "high") high++;
      else if (r.match?.band === "medium") mid++;
      else low++;
    }
    return { high, mid, low, none, included };
  }, [job.matches]);

  const rows = showAll
    ? job.matches
    : job.matches.filter(r => r.status === "nomatch" || (r.match && r.match.band !== "high"));

  async function commit() { setCommitting(true); try { await api.commit(job.id); onCommit(); } finally { setCommitting(false); } }

  return (
    <div className="card">
      <div className="row-between">
        <h2>4 · Review matches</h2>
        <div style={{ display: "flex", gap: 6 }}>
          <span className="pill" style={{ color: "var(--green)" }}>{stats.high} high</span>
          <span className="pill" style={{ color: "var(--yellow)" }}>{stats.mid} medium</span>
          <span className="pill" style={{ color: "var(--peach)" }}>{stats.low} low</span>
          <span className="pill" style={{ color: "var(--red)" }}>{stats.none} no match</span>
        </div>
      </div>
      <p className="hint">
        {stats.included.toLocaleString()} songs will be added. High-confidence matches are hidden —{" "}
        <a onClick={() => setShowAll(s => !s)} style={{ cursor: "pointer" }}>{showAll ? "show only what needs attention" : "show all"}</a>.
      </p>

      <div className="scroll-tbl">
        <table className="matches">
          <thead>
            <tr><th>Spotify track</th><th>Matched on YouTube Music</th><th style={{ width: 70 }}>Conf.</th><th style={{ width: 260 }}>Fix</th></tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.track.id} className={r.included ? "" : "excluded"}>
                <td>
                  {r.track.name}
                  <div className="src">{r.track.artists.join(", ")} · {job.sources[r.source_index]?.name}</div>
                </td>
                <td>{r.match ? <>{r.match.title}<div className="src">{r.match.artists.join(", ")}</div></> : <span className="muted">— no result —</span>}</td>
                <td><span className={`conf ${confClass(r)}`}>{r.status === "nomatch" ? "—" : r.match?.confidence}</span></td>
                <td><RowActions jobId={job.id} row={r} refresh={refresh} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 16 }}>
        <button className="btn primary" disabled={committing || stats.included === 0} onClick={commit}>
          {committing ? "Creating…" : `Create playlists & add ${stats.included.toLocaleString()} songs →`}
        </button>
      </div>
    </div>
  );
}
