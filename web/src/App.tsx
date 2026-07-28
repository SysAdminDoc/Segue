import { useCallback, useEffect, useRef, useState } from "react";
import { api, Job, Status } from "./api";
import Connect from "./components/Connect";
import PickSources from "./components/PickSources";
import Review from "./components/Review";
import Progress from "./components/Progress";

type Stage = "connect" | "pick" | "job";

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const jobPoll = useRef<number | null>(null);

  const refreshStatus = useCallback(() => { api.status().then(setStatus).catch(() => {}); }, []);
  const refreshJob = useCallback(() => {
    if (jobId) api.job(jobId).then(setJob).catch(() => {});
  }, [jobId]);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  // Poll the job while it is doing background work; stop once it needs the user.
  useEffect(() => {
    if (!jobId) return;
    refreshJob();
    jobPoll.current = window.setInterval(() => {
      api.job(jobId).then(j => {
        setJob(j);
        if (["review", "done", "error"].includes(j.phase) && jobPoll.current) {
          window.clearInterval(jobPoll.current);
        }
      }).catch(() => {});
    }, 1500);
    return () => { if (jobPoll.current) window.clearInterval(jobPoll.current); };
  }, [jobId, refreshJob]);

  const bothConnected = status?.spotify.connected && status?.ytmusic.connected;
  let stage: Stage = "connect";
  if (jobId) stage = "job";
  else if (bothConnected) stage = "pick";

  return (
    <div className="wrap">
      <div className="brand"><span className="dot" /><h1>Segue</h1></div>
      <p className="tagline">Move your Spotify playlists and liked songs to YouTube Music — with a review step so nothing lands on the wrong track.</p>

      <div className="steps">
        <div className={`step ${stage === "connect" ? "active" : "done"}`}>Connect</div>
        <div className={`step ${stage === "pick" ? "active" : stage === "job" ? "done" : ""}`}>Choose</div>
        <div className={`step ${stage === "job" && job?.phase === "review" ? "active" : job?.phase === "done" ? "done" : ""}`}>Review</div>
        <div className={`step ${stage === "job" && (job?.phase === "writing" || job?.phase === "done") ? "active" : ""}`}>Transfer</div>
      </div>

      {stage === "connect" && status && <Connect status={status} refresh={refreshStatus} />}
      {stage === "pick" && <PickSources onStart={setJobId} />}
      {stage === "job" && job && (
        <>
          {(job.phase === "matching" || job.phase === "writing" || job.phase === "done" || job.phase === "error") && <Progress job={job} />}
          {job.phase === "review" && <Review job={job} refresh={refreshJob} onCommit={refreshJob} />}
          {job.phase === "done" && (
            <div style={{ marginTop: 12 }}>
              <button className="btn ghost" onClick={() => { setJobId(null); setJob(null); }}>Migrate more</button>
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
