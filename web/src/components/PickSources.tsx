import { useEffect, useState } from "react";
import { api, Source } from "../api";

export default function PickSources({ onStart }: { onStart: (jobId: string) => void }) {
  const [liked, setLiked] = useState<Source | null>(null);
  const [playlists, setPlaylists] = useState<Source[]>([]);
  const [picked, setPicked] = useState<Record<string, Source>>({});
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.playlists()
      .then(d => { setLiked(d.liked); setPlaylists(d.playlists); })
      .catch(e => setErr((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  function toggle(s: Source) {
    setPicked(p => {
      const next = { ...p };
      if (next[s.id]) delete next[s.id]; else next[s.id] = s;
      return next;
    });
  }

  const chosen = Object.values(picked);
  const totalSongs = chosen.reduce((n, s) => n + s.total, 0);

  async function start() {
    setBusy(true); setErr("");
    try { const { jobId } = await api.startTransfer(chosen); onStart(jobId); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  if (loading) return <div className="card">Loading your Spotify library…</div>;

  return (
    <div className="card">
      <h2>3 · Choose what to migrate</h2>
      <p className="hint">Selected: {chosen.length} source(s), {totalSongs.toLocaleString()} songs.</p>
      <div className="list">
        {liked && (
          <label className="item">
            <input type="checkbox" checked={!!picked[liked.id]} onChange={() => toggle(liked)} />
            <span className="name">❤ {liked.name}</span>
            <span className="count">{liked.total.toLocaleString()}</span>
          </label>
        )}
        {playlists.map(p => (
          <label className="item" key={p.id}>
            <input type="checkbox" checked={!!picked[p.id]} onChange={() => toggle(p)} />
            <span className="name">{p.name}</span>
            <span className="count">{p.total.toLocaleString()}</span>
          </label>
        ))}
      </div>
      {err && <div className="err">{err}</div>}
      <div style={{ marginTop: 16 }}>
        <button className="btn primary" disabled={busy || chosen.length === 0} onClick={start}>
          {busy ? "Starting…" : `Match ${totalSongs.toLocaleString()} songs →`}
        </button>
      </div>
    </div>
  );
}
