// Thin API client. Same-origin in prod; Vite proxies /api in dev. Cookies carry
// the session, so every request includes credentials.
const BASE = import.meta.env.VITE_API_BASE ?? "";

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `${res.status} ${res.statusText}`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export interface Status {
  spotify: { connected: boolean; user: { id: string; name: string } | null; source?: string; count?: number };
  ytmusic: { connected: boolean };
}
export interface Source { type: "playlist" | "liked"; id: string; name: string; total: number; image?: string }
export interface Candidate { videoId: string; title: string; artists: string[]; confidence: number }
export interface Match {
  videoId: string; title: string; artists: string[];
  confidence: number; band: string; alternates: Candidate[];
}
export interface Row {
  track: { id: string; name: string; artists: string[]; album: string; duration_ms: number };
  source_index: number; match: Match | null; status: string;
  selected_videoId: string | null; included: boolean;
}
export interface Job {
  id: string; phase: string; sources: Source[]; matches: Row[];
  matched_count: number; total: number; added_count: number;
  playlists_created: { name: string; playlistId: string; url: string; added: number }[];
  error: string | null;
}

export const api = {
  status: () => req<Status>("/api/status"),
  spotifyLoginUrl: () => `${BASE}/api/auth/spotify/login`,
  userscriptUrl: () => `${BASE}/segue-spotify.user.js`,
  importClaim: (import_id: string) => req<{ ok: boolean; count: number }>(
    "/api/import/claim", { method: "POST", body: JSON.stringify({ import_id }) }),
  ytOAuthStart: () => req<{ user_code: string; verification_url: string; interval: number; expires_in: number }>(
    "/api/auth/ytmusic/oauth/start", { method: "POST" }),
  ytOAuthPoll: () => req<{ status: "pending" | "connected" }>("/api/auth/ytmusic/oauth/poll", { method: "POST" }),
  ytHeaders: (raw_headers: string) => req("/api/auth/ytmusic/headers", { method: "POST", body: JSON.stringify({ raw_headers }) }),
  playlists: () => req<{ liked: Source; playlists: Source[] }>("/api/playlists"),
  startTransfer: (sources: Source[]) => req<{ jobId: string }>("/api/transfer", { method: "POST", body: JSON.stringify({ sources }) }),
  job: (id: string) => req<Job>(`/api/transfer/${id}`),
  jobEvents: (id: string, onJob: (job: Job) => void) => {
    const events = new EventSource(`${BASE}/api/transfer/${id}/events`, { withCredentials: true });
    events.addEventListener("job", event => onJob(JSON.parse((event as MessageEvent<string>).data) as Job));
    return events;
  },
  rematch: (id: string, track_id: string, video_id: string, title: string, artists: string[]) =>
    req(`/api/transfer/${id}/rematch`, { method: "POST", body: JSON.stringify({ track_id, video_id, title, artists }) }),
  toggle: (id: string, track_id: string, included: boolean) =>
    req(`/api/transfer/${id}/toggle`, { method: "POST", body: JSON.stringify({ track_id, included }) }),
  bulk: (id: string, action: "include_medium" | "exclude_nomatch") =>
    req<{ ok: boolean; changed: number }>(`/api/transfer/${id}/bulk`, { method: "POST", body: JSON.stringify({ action }) }),
  unmatchedCsvUrl: (id: string) => `${BASE}/api/transfer/${id}/unmatched.csv`,
  search: (id: string, query: string) => req<{ results: Candidate[] }>(`/api/transfer/${id}/search`, { method: "POST", body: JSON.stringify({ query }) }),
  commit: (id: string) => req(`/api/transfer/${id}/commit`, { method: "POST" }),
};
