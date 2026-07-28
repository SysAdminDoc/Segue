import { useEffect, useRef, useState } from "react";
import { api, Status } from "../api";

export default function Connect({ status, refresh }: { status: Status; refresh: () => void }) {
  const [mode, setMode] = useState<"oauth" | "headers">("oauth");
  const [device, setDevice] = useState<{ user_code: string; verification_url: string } | null>(null);
  const [headers, setHeaders] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const poll = useRef<number | null>(null);

  useEffect(() => () => { if (poll.current) window.clearInterval(poll.current); }, []);

  async function startOAuth() {
    setErr(""); setBusy(true);
    try {
      const d = await api.ytOAuthStart();
      setDevice(d);
      poll.current = window.setInterval(async () => {
        try {
          const r = await api.ytOAuthPoll();
          if (r.status === "connected") {
            if (poll.current) window.clearInterval(poll.current);
            setDevice(null); refresh();
          }
        } catch { /* keep polling */ }
      }, (d.interval || 5) * 1000);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function submitHeaders() {
    setErr(""); setBusy(true);
    try { await api.ytHeaders(headers); refresh(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <div className="card">
        <div className="row-between">
          <div>
            <h2>1 · Connect Spotify</h2>
            <p className="hint">Read-only access to your playlists and liked songs.</p>
          </div>
          {status.spotify.connected
            ? <span className="pill ok">✓ {status.spotify.user?.name || "Connected"}</span>
            : <a className="btn spotify" href={api.spotifyLoginUrl()}>Connect Spotify</a>}
        </div>
      </div>

      <div className="card">
        <div className="row-between">
          <div>
            <h2>2 · Connect YouTube Music</h2>
            <p className="hint">Where your playlists will be created. No daily transfer quota.</p>
          </div>
          {status.ytmusic.connected && <span className="pill ok">✓ Connected</span>}
        </div>

        {!status.ytmusic.connected && (
          <>
            <div className="tabs">
              <div className={`tab ${mode === "oauth" ? "active" : ""}`} onClick={() => setMode("oauth")}>Sign in with Google</div>
              <div className={`tab ${mode === "headers" ? "active" : ""}`} onClick={() => setMode("headers")}>Paste request headers</div>
            </div>

            {mode === "oauth" && (
              <button className="btn yt" disabled={busy} onClick={startOAuth}>Get a sign-in code</button>
            )}
            {mode === "headers" && (
              <>
                <p className="muted">Advanced: open music.youtube.com while logged in, open DevTools → Network,
                  copy the request headers of any <code>/browse</code> POST and paste them here.</p>
                <textarea value={headers} onChange={e => setHeaders(e.target.value)} placeholder="accept: */*&#10;cookie: ...&#10;authorization: ..." />
                <div style={{ marginTop: 10 }}>
                  <button className="btn yt" disabled={busy || !headers.trim()} onClick={submitHeaders}>Connect with headers</button>
                </div>
              </>
            )}
            {err && <div className="err">{err}</div>}
          </>
        )}
      </div>

      {device && (
        <div className="modal-bg" onClick={() => { if (poll.current) window.clearInterval(poll.current); setDevice(null); }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Authorize YouTube Music</h2>
            <p className="hint">Go to <a href={device.verification_url} target="_blank" rel="noreferrer">{device.verification_url}</a> and enter this code:</p>
            <div className="code">{device.user_code}</div>
            <p className="muted">Waiting for you to approve… this window closes automatically.</p>
          </div>
        </div>
      )}
    </>
  );
}
