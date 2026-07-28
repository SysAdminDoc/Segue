// ==UserScript==
// @name         Segue — Spotify → YouTube Music exporter
// @namespace    https://segue.getparkerai.com
// @version      0.3.0
// @description  Export your Spotify playlists & liked songs (no developer app, no Premium) and send them to Segue to migrate to YouTube Music.
// @author       SysAdminDoc
// @match        https://open.spotify.com/*
// @icon         https://open.spotify.com/favicon.ico
// @grant        GM_xmlhttpRequest
// @connect      api.spotify.com
// @connect      api-partner.spotify.com
// @connect      segue.getparkerai.com
// @run-at       document-start
// @downloadURL  https://segue.getparkerai.com/segue-spotify.user.js
// @updateURL    https://segue.getparkerai.com/segue-spotify.user.js
// ==/UserScript==

/*
 * WHY v0.3.0 works where v0.1/0.2 didn't:
 * A userscript's window.fetch override lives in an ISOLATED world — it never
 * touches the page's real fetch, so the token was never captured. Here we inject
 * the hook into the PAGE's main world via a <script> element, and relay the
 * captured bearer + client-token back to the userscript via a CustomEvent. All
 * network calls go through GM_xmlhttpRequest (no CORS headaches). We reuse the
 * token the web player already minted, so there's no TOTP to solve. If the plain
 * REST library endpoints are refused, we replay the player's own pathfinder
 * GraphQL request (captured live, so its rotating query-hash is always current).
 * Your Spotify login never leaves the browser — only track metadata is sent.
 */
(function () {
  "use strict";
  const SEGUE = "https://segue.getparkerai.com";
  const API = "https://api.spotify.com/v1";

  // ---------------------------------------------------------------------------
  // PAGE-CONTEXT HOOK — injected into the real page so it patches Spotify's fetch
  // ---------------------------------------------------------------------------
  function pageHook() {
    const relay = o => window.dispatchEvent(new CustomEvent("segue-cap", { detail: JSON.stringify(o) }));
    const oFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        // Normalize through a Request so we read headers regardless of whether
        // Spotify passed a URL string + init or a prebuilt Request object. (This
        // is the fix — the old code missed the auth header on Request inputs.)
        const req = new Request(input, init);
        const url = req.url || "";
        const auth = req.headers.get("authorization");
        const ct = req.headers.get("client-token");
        if (auth && auth.indexOf("Bearer ") === 0) relay({ bearer: auth.slice(7) });
        if (ct) relay({ clientToken: ct });
        const body = init && typeof init.body === "string" ? init.body : null;
        if (url.indexOf("/pathfinder/") > -1 && body && /[Ll]ibrary|[Pp]laylist/.test(body)) {
          relay({ pf: { url: url, body: body } });
        }
      } catch (e) { /* ignore */ }
      return oFetch.apply(this, arguments);
    };
    const oOpen = XMLHttpRequest.prototype.open;
    const oSet = XMLHttpRequest.prototype.setRequestHeader;
    const oSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__segUrl = u; return oOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      const lk = String(k).toLowerCase();
      if (lk === "authorization" && String(v).indexOf("Bearer ") === 0) relay({ bearer: String(v).slice(7) });
      if (lk === "client-token") relay({ clientToken: String(v) });
      return oSet.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      try {
        if (this.__segUrl && String(this.__segUrl).indexOf("/pathfinder/") > -1 && typeof body === "string" && /[Ll]ibrary|[Pp]laylist/.test(body)) {
          relay({ pf: { url: String(this.__segUrl), body: body } });
        }
      } catch (e) { /* ignore */ }
      return oSend.apply(this, arguments);
    };
  }
  const inj = document.createElement("script");
  inj.textContent = "(" + pageHook.toString() + ")();";
  (document.head || document.documentElement).appendChild(inj);
  inj.remove();

  // ---------------------------------------------------------------------------
  // USERSCRIPT CONTEXT — receive captured creds, drive the export
  // ---------------------------------------------------------------------------
  let bearer = null, clientToken = null, pfTemplate = null;
  window.addEventListener("segue-cap", e => {
    try {
      const d = JSON.parse(e.detail);
      if (d.bearer) bearer = d.bearer;
      if (d.clientToken) clientToken = d.clientToken;
      if (d.pf) pfTemplate = d.pf;
      updateBadge();
    } catch (e) { /* ignore */ }
  });

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function gm(method, url, headers, data) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method, url, headers, data, timeout: 30000,
        onload: r => resolve(r),
        onerror: () => reject(new Error("network error")),
        ontimeout: () => reject(new Error("timeout")),
      });
    });
  }

  // --- REST library reader (primary) ----------------------------------------
  async function rest(path) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const r = await gm("GET", `${API}${path}`, { authorization: `Bearer ${bearer}` });
      if (r.status === 429) { await sleep((parseInt(r.responseHeaders.match(/retry-after:\s*(\d+)/i)?.[1] || "2", 10) + 1) * 1000); continue; }
      if (r.status === 401) throw new Error("token-expired");
      if (r.status === 403) throw new Error("rest-forbidden");
      if (r.status < 200 || r.status >= 300) throw new Error(`Spotify ${r.status}`);
      return JSON.parse(r.responseText);
    }
    throw new Error("rate-limited");
  }

  function normRest(t) {
    if (!t || t.is_local || !t.id) return null;
    return {
      id: t.id, name: t.name || "",
      artists: (t.artists || []).map(a => a.name),
      album: (t.album && t.album.name) || "",
      duration_ms: t.duration_ms || 0,
      isrc: (t.external_ids && t.external_ids.isrc) || null,
    };
  }

  async function restPageAll(firstPath, onProgress) {
    const out = []; let path = firstPath;
    while (path) {
      const page = await rest(path);
      for (const item of page.items || []) { const nt = normRest(item.track || item); if (nt) out.push(nt); }
      if (onProgress) onProgress(out.length);
      path = page.next ? page.next.replace(API, "") : null;
    }
    return out;
  }

  async function restPlaylists() {
    const out = []; let path = "/me/playlists?limit=50";
    while (path) {
      const page = await rest(path);
      for (const p of page.items || []) if (p) out.push({ id: p.id, name: p.name, total: (p.tracks || {}).total || 0 });
      path = page.next ? page.next.replace(API, "") : null;
    }
    return out;
  }

  // --- Pathfinder fallback (replays the player's own captured request) -------
  function collectPathfinderTracks(node, out, seen) {
    // Defensive walk: find track-shaped objects anywhere in the response.
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(n => collectPathfinderTracks(n, out, seen)); return; }
    const uri = node.uri || (node.data && node.data.uri);
    const isTrack = typeof uri === "string" && uri.indexOf("spotify:track:") === 0;
    if (isTrack) {
      const d = node.data && node.data.uri ? node.data : node;
      const id = uri.split(":").pop();
      if (!seen.has(id)) {
        seen.add(id);
        const artists = ((d.artists && d.artists.items) || []).map(a => (a.profile && a.profile.name) || a.name).filter(Boolean);
        out.push({
          id, name: d.name || "",
          artists,
          album: (d.albumOfTrack && d.albumOfTrack.name) || (d.album && d.album.name) || "",
          duration_ms: (d.trackDuration && d.trackDuration.totalMilliseconds) || d.duration_ms || 0,
          isrc: null, // pathfinder doesn't expose ISRC; matcher falls back to name+artist
        });
      }
    }
    for (const k in node) if (k !== "data" || !isTrack) collectPathfinderTracks(node[k], out, seen);
  }

  async function pathfinderLiked(onProgress) {
    if (!pfTemplate) throw new Error("no-pathfinder-template");
    let base;
    try { base = JSON.parse(pfTemplate.body); } catch (e) { throw new Error("bad-template"); }
    const out = [], seen = new Set(); let offset = 0; const limit = 100;
    for (let guard = 0; guard < 500; guard++) {
      base.variables = Object.assign({}, base.variables, { offset, limit });
      const r = await gm("POST", pfTemplate.url, {
        authorization: `Bearer ${bearer}`,
        "client-token": clientToken || "",
        "content-type": "application/json",
        "app-platform": "WebPlayer",
      }, JSON.stringify(base));
      if (r.status === 401) throw new Error("token-expired");
      if (r.status !== 200) throw new Error(`pathfinder ${r.status}`);
      const before = out.length;
      collectPathfinderTracks(JSON.parse(r.responseText), out, seen);
      if (onProgress) onProgress(out.length);
      if (out.length - before === 0) break;
      offset += limit;
    }
    return out;
  }

  function send(payload) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST", url: `${SEGUE}/api/import/spotify`,
        headers: { "Content-Type": "application/json" }, data: JSON.stringify(payload),
        onload: r => { try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(new Error("Bad response from Segue")); } },
        onerror: () => reject(new Error("Could not reach Segue")),
      });
    });
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  const css = `
    #segue-fab{position:fixed;right:20px;bottom:20px;z-index:99999;background:linear-gradient(135deg,#1DB954,#cba6f7);
      color:#11111b;border:none;border-radius:10px;padding:12px 18px;font:600 14px/1 system-ui,sans-serif;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.4)}
    #segue-fab small{display:block;font-weight:500;font-size:11px;opacity:.85;margin-top:3px}
    #segue-fab:hover{filter:brightness(1.08)}
    #segue-modal{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center}
    #segue-box{background:#1e1e2e;color:#cdd6f4;border:1px solid #45475a;border-radius:12px;padding:22px;width:460px;max-width:92vw;font:14px/1.5 system-ui,sans-serif}
    #segue-box h3{margin:0 0 4px;font-size:18px}
    #segue-box .sub{color:#a6adc8;margin:0 0 14px;font-size:13px}
    #segue-list{max-height:44vh;overflow:auto;border:1px solid #313244;border-radius:8px;margin-bottom:14px}
    #segue-list label{display:flex;gap:10px;align-items:center;padding:8px 10px;cursor:pointer}
    #segue-list label:nth-child(odd){background:#181825}
    #segue-list .n{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #segue-list .c{color:#a6adc8;font-size:12px}
    .segue-btn{border:none;border-radius:8px;padding:9px 16px;font:600 13px/1 system-ui;cursor:pointer}
    .segue-go{background:#cba6f7;color:#11111b}
    .segue-x{background:#313244;color:#cdd6f4;margin-right:8px}
    #segue-status{color:#a6adc8;font-size:13px;min-height:18px}
    #segue-diag{margin-top:10px;font:11px/1.5 ui-monospace,monospace;color:#6c7086;border-top:1px solid #313244;padding-top:8px}
    #segue-diag b{color:#a6e3a1}.segue-bad{color:#f38ba8 !important}
  `;
  function styleOnce() { if (!document.getElementById("segue-style")) { const s = document.createElement("style"); s.id = "segue-style"; s.textContent = css; document.head.appendChild(s); } }

  function updateBadge() {
    const fab = document.getElementById("segue-fab");
    if (fab) fab.querySelector("small").textContent = bearer ? "✓ ready" : "reading session…";
    const diag = document.getElementById("segue-diag");
    if (diag) diag.innerHTML = diagHtml();
  }
  function diagHtml() {
    const ok = v => v ? "<b>yes</b>" : "<span class='segue-bad'>no</span>";
    return `token: ${ok(bearer)} · client-token: ${ok(clientToken)} · pathfinder-template: ${ok(pfTemplate)}`;
  }

  function fab() {
    if (document.getElementById("segue-fab")) return;
    const b = document.createElement("button");
    b.id = "segue-fab";
    b.innerHTML = "Export to YouTube Music<small>reading session…</small>";
    b.onclick = openModal;
    document.body.appendChild(b);
    updateBadge();
  }

  let modal;
  async function waitForToken(ms) {
    const t0 = Date.now();
    while (!bearer && Date.now() - t0 < ms) await sleep(300);
    return !!bearer;
  }

  async function openModal() {
    styleOnce();
    if (!bearer) {
      const got = await waitForToken(6000);
      if (!got) { alert("Segue: couldn't read your Spotify session yet.\n\n• Make sure you're logged in (free is fine)\n• Click your Library or any playlist once, then click Export again."); return; }
    }
    modal = document.createElement("div");
    modal.id = "segue-modal";
    modal.innerHTML = `<div id="segue-box">
      <h3>Export your Spotify library</h3>
      <p class="sub">Pick what to migrate. Only track details leave your browser — never your login.</p>
      <div id="segue-list">Loading your playlists…</div>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span id="segue-status"></span>
        <span><button class="segue-btn segue-x">Cancel</button><button class="segue-btn segue-go">Export →</button></span>
      </div>
      <div id="segue-diag">${diagHtml()}</div>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelector(".segue-x").onclick = () => modal.remove();
    modal.querySelector(".segue-go").onclick = doExport;
    try {
      const pls = await restPlaylists();
      const list = modal.querySelector("#segue-list");
      list.innerHTML = "";
      list.appendChild(row("liked", "❤ Liked Songs", "", true));
      pls.forEach(p => list.appendChild(row("pl:" + p.id, p.name, p.total, false, p)));
    } catch (e) {
      modal.querySelector("#segue-list").innerHTML =
        `Couldn't list playlists (${e.message}). Liked Songs may still work — leave it checked and hit Export.`;
      const list = modal.querySelector("#segue-list");
      list.appendChild(row("liked", "❤ Liked Songs", "", true));
    }
  }

  function row(key, name, count, checked, pl) {
    const l = document.createElement("label");
    l.innerHTML = `<input type="checkbox" ${checked ? "checked" : ""}><span class="n"></span><span class="c">${count || ""}</span>`;
    l.querySelector(".n").textContent = name;
    l.dataset.key = key;
    if (pl) l._pl = pl;
    return l;
  }

  async function likedTracks(status) {
    // Primary: REST. Fallback: replay the player's captured pathfinder request.
    try {
      return await restPageAll("/me/tracks?limit=50", n => status.textContent = `Liked Songs… ${n}`);
    } catch (e) {
      if (e.message === "token-expired") throw e;
      status.textContent = "Liked Songs via player API…";
      if (!pfTemplate) {
        throw new Error("Open your Liked Songs page in Spotify once (so Segue can learn the query), then Export again.");
      }
      return await pathfinderLiked(n => status.textContent = `Liked Songs (player API)… ${n}`);
    }
  }

  async function doExport() {
    const status = modal.querySelector("#segue-status");
    const rows = [...modal.querySelectorAll("#segue-list label")].filter(l => l.querySelector("input").checked);
    if (!rows.length) { status.textContent = "Select at least one."; return; }
    modal.querySelector(".segue-go").disabled = true;
    try {
      const payload = { liked: null, playlists: [] };
      for (const r of rows) {
        if (r.dataset.key === "liked") {
          status.textContent = "Exporting Liked Songs…";
          payload.liked = { name: "Liked Songs", tracks: await likedTracks(status) };
        } else {
          const pl = r._pl;
          status.textContent = `Exporting “${pl.name}”…`;
          const tracks = await restPageAll(`/playlists/${pl.id}/tracks?limit=100`, n => status.textContent = `${pl.name}… ${n}`);
          payload.playlists.push({ id: pl.id, name: pl.name, tracks });
        }
      }
      const count = (payload.liked ? payload.liked.tracks.length : 0) + payload.playlists.reduce((n, p) => n + p.tracks.length, 0);
      if (!count) { status.textContent = "Nothing exported — see diagnostics below."; modal.querySelector(".segue-go").disabled = false; return; }
      status.textContent = `Sending ${count} songs to Segue…`;
      const res = await send(payload);
      status.textContent = `Done — ${res.count} songs. Opening Segue…`;
      window.open(`${SEGUE}/#import=${res.import_id}`, "_blank");
      setTimeout(() => modal.remove(), 1500);
    } catch (e) {
      const msg = e.message === "token-expired" ? "Session expired — refresh Spotify and retry." : e.message;
      status.textContent = "Error: " + msg;
      modal.querySelector(".segue-go").disabled = false;
    }
  }

  const boot = setInterval(() => { if (document.body) { styleOnce(); fab(); clearInterval(boot); } }, 400);
})();
