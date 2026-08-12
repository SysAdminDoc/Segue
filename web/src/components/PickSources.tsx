import { useEffect, useState } from "react";
import { api, Source } from "../api";

export default function PickSources({ onStart }: { onStart: (jobId: string) => void }) {
  const [liked, setLiked] = useState<Source | null>(null);
  const [playlists, setPlaylists] = useState<Source[]>([]);
  const [albums, setAlbums] = useState<Source[]>([]);
  const [artists, setArtists] = useState<Source[]>([]);
  const [picked, setPicked] = useState<Record<string, Source>>({});
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.playlists()
      .then(d => {
        setLiked(d.liked);
        setPlaylists(d.playlists);
        setAlbums(d.albums);
        setArtists(d.artists);
      })
      .catch(e => setErr((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  function toggle(s: Source) {
    const key = `${s.type}:${s.id}`;
    setPicked(p => {
      const next = { ...p };
      if (next[key]) delete next[key]; else next[key] = s;
      return next;
    });
  }

  function sourceRows(title: string, icon: string, sources: Source[]) {
    if (!sources.length) return null;
    return (
      <>
        <div className="list-section">{title}</div>
        {sources.map(source => {
          const key = `${source.type}:${source.id}`;
          return (
            <label className="item" key={key}>
              <input type="checkbox" checked={!!picked[key]} onChange={() => toggle(source)} />
              <span className="name">{icon} {source.name}</span>
              <span className="count">{source.total_known === false ? "catalog" : source.total.toLocaleString()}</span>
            </label>
          );
        })}
      </>
    );
  }

  const chosen = Object.values(picked);
  const totalSongs = chosen.reduce((n, s) => n + s.total, 0);
  const hasUnknownTotal = chosen.some(s => s.total_known === false);

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
            <input type="checkbox" checked={!!picked[`${liked.type}:${liked.id}`]} onChange={() => toggle(liked)} />
            <span className="name">❤ {liked.name}</span>
            <span className="count">{liked.total.toLocaleString()}</span>
          </label>
        )}
        {sourceRows("Playlists", "♫", playlists)}
        {sourceRows("Saved albums", "◉", albums)}
        {sourceRows("Followed artists", "★", artists)}
      </div>
      {err && <div className="err">{err}</div>}
      <div style={{ marginTop: 16 }}>
        <button className="btn primary" disabled={busy || chosen.length === 0} onClick={start}>
          {busy ? "Starting…" : hasUnknownTotal ? "Load catalogs & match →" : `Match ${totalSongs.toLocaleString()} songs →`}
        </button>
      </div>
    </div>
  );
}
