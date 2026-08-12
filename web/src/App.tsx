import { useCallback, useEffect, useState } from "react";
import { api, Job, Status } from "./api";
import Connect from "./components/Connect";
import PickSources from "./components/PickSources";
import Review from "./components/Review";
import Progress from "./components/Progress";

type Stage = "connect" | "pick" | "job";

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [jobId, setJobId] = useState<string | null>(() => window.sessionStorage.getItem("segue.jobId"));
  const [job, setJob] = useState<Job | null>(null);

  const [claiming, setClaiming] = useState(false);
  const refreshStatus = useCallback(() => { api.status().then(setStatus).catch(() => {}); }, []);

  // The userscript opens us at /#import=<id>; claim that library into this session.
  useEffect(() => {
    const m = window.location.hash.match(/import=([a-f0-9]+)/);
    if (!m) return;
    setClaiming(true);
    window.history.replaceState(null, "", window.location.pathname);
    api.importClaim(m[1]).then(() => refreshStatus()).finally(() => setClaiming(false));
  }, [refreshStatus]);
  const refreshJob = useCallback(() => {
    if (jobId) api.job(jobId).then(setJob).catch(() => {});
  }, [jobId]);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  // One event stream carries matching, review edits, and write progress.
  useEffect(() => {
    if (!jobId) return;
    api.job(jobId).then(setJob).catch(() => {
      window.sessionStorage.removeItem("segue.jobId");
      setJobId(current => current === jobId ? null : current);
    });
    const events = api.jobEvents(jobId, next => {
      setJob(next);
      if (["done", "error"].includes(next.phase)) events.close();
    });
    return () => events.close();
  }, [jobId, refreshJob]);

  function startJob(id: string) {
    window.sessionStorage.setItem("segue.jobId", id);
    setJobId(id);
  }

  function clearJob() {
    window.sessionStorage.removeItem("segue.jobId");
    setJobId(null);
    setJob(null);
  }

  const bothConnected = status?.spotify.connected && status?.ytmusic.connected;
  let stage: Stage = "connect";
  if (jobId) stage = "job";
  else if (bothConnected) stage = "pick";

  return (
    <div className="wrap">
      <div className="brand"><span className="dot" /><h1>Segue</h1></div>
      <p className="tagline">Move your Spotify playlists, liked songs, saved albums, and followed artists to YouTube Music — with a review step so nothing lands on the wrong track.</p>

      <div className="steps">
        <div className={`step ${stage === "connect" ? "active" : "done"}`}>Connect</div>
        <div className={`step ${stage === "pick" ? "active" : stage === "job" ? "done" : ""}`}>Choose</div>
        <div className={`step ${stage === "job" && job?.phase === "review" ? "active" : job?.phase === "done" ? "done" : ""}`}>Review</div>
        <div className={`step ${stage === "job" && (job?.phase === "writing" || job?.phase === "done") ? "active" : ""}`}>Transfer</div>
      </div>

      {claiming && <div className="card">Importing your Spotify library…</div>}
      {stage === "connect" && status && <Connect status={status} refresh={refreshStatus} />}
      {stage === "pick" && <PickSources onStart={startJob} />}
      {stage === "job" && job && (
        <>
          {(job.phase === "matching" || job.phase === "writing" || job.phase === "done" || job.phase === "error") && <Progress job={job} />}
          {job.phase === "review" && <Review job={job} refresh={refreshJob} onCommit={refreshJob} />}
          {job.phase === "done" && (
            <div style={{ marginTop: 12 }}>
              <button className="btn ghost" onClick={clearJob}>Migrate more</button>
            </div>
          )}
        </>
      )}

      <p className="muted" style={{ marginTop: 40 }}>
        Segue reads your Spotify library read-only and never stores your credentials. Open source ·{" "}
        <a href="https://github.com/SysAdminDoc/Segue" target="_blank" rel="noreferrer">source on GitHub</a>
      </p>
    </div>
  );
}
