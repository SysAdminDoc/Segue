// ==UserScript==
// @name         Segue — Spotify → YouTube Music exporter
// @namespace    https://segue.getparkerai.com
// @version      0.6.0
// @description  Export Spotify playlists, liked songs, saved albums, and followed artists to Segue (no developer app or Premium).
// @author       SysAdminDoc
// @match        https://open.spotify.com/*
// @icon         https://open.spotify.com/favicon.ico
// @inject-into  page
// @grant        none
// @run-at       document-start
// @downloadURL  https://segue.getparkerai.com/segue-spotify.user.js
// @updateURL    https://segue.getparkerai.com/segue-spotify.user.js
// ==/UserScript==

/*
 * WHY v0.6.0 — the capture saga, resolved:
 *  - v0.2 hooked fetch in the userscript SANDBOX → never touched the page's fetch.
 *  - v0.3 injected an inline <script> → blocked by Spotify's CSP.
 *  - v0.4/0.5 patched via `unsafeWindow` → in some Tampermonkey setups unsafeWindow
 *    is NOT the real page window, so the hook silently missed everything.
 *  - v0.6 runs the whole script IN THE PAGE CONTEXT (`@grant none` / `@inject-into
 *    page`). Now `window.fetch` literally IS the player's fetch, so patching it
 *    always works, and Tampermonkey's page injection bypasses CSP. All network
 *    calls use plain fetch — verified that api.spotify.com AND Segue both allow
 *    CORS from open.spotify.com, so no GM_xmlhttpRequest is needed.
 * We reuse the token the web player already minted (no TOTP). Paced under
 * Spotify's ~180 req/min limit. Your login never leaves the browser.
 */
(function () {
  "use strict";
  const SEGUE = "https://segue.getparkerai.com";
  const API = "https://api.spotify.com/v1";

  let bearer = null, clientToken = null, pfTemplate = null, logEl = null;

  // ---------------------------------------------------------------------------
  // Capture the web-player's token by patching the page's own fetch/XHR
  // ---------------------------------------------------------------------------
  function installHooks() {
    if (window.__segueHooked) return;
    window.__segueHooked = true;

    const oFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        const req = new Request(input, init);
        const url = req.url || "";
        const auth = req.headers.get("authorization");
        const ct = req.headers.get("client-token");
        if (auth && auth.indexOf("Bearer ") === 0 && auth.slice(7) !== bearer) { bearer = auth.slice(7); onCred(); }
        if (ct && ct !== clientToken) { clientToken = ct; onCred(); }
        const body = init && typeof init.body === "string" ? init.body : null;
        if (url.indexOf("/pathfinder/") > -1 && body && /[Ll]ibrary|[Pp]laylist/.test(body)) { pfTemplate = { url, body }; onCred(); }
      } catch (e) { /* ignore */ }
      return oFetch.apply(this, arguments);
    };

    const XHR = window.XMLHttpRequest;
    const oOpen = XHR.prototype.open, oSet = XHR.prototype.setRequestHeader, oSend = XHR.prototype.send;
    XHR.prototype.open = function (m, u) { this.__segUrl = u; return oOpen.apply(this, arguments); };
    XHR.prototype.setRequestHeader = function (k, v) {
      try {
        const lk = String(k).toLowerCase();
        if (lk === "authorization" && String(v).indexOf("Bearer ") === 0 && String(v).slice(7) !== bearer) { bearer = String(v).slice(7); onCred(); }
        if (lk === "client-token" && String(v) !== clientToken) { clientToken = String(v); onCred(); }
      } catch (e) { /* ignore */ }
      return oSet.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      try {
        if (this.__segUrl && String(this.__segUrl).indexOf("/pathfinder/") > -1 && typeof body === "string" && /[Ll]ibrary|[Pp]laylist/.test(body)) { pfTemplate = { url: String(this.__segUrl), body }; onCred(); }
      } catch (e) { /* ignore */ }
      return oSend.apply(this, arguments);
    };
  }
  let credLogged = false;
  function onCred() { updateBadge(); if (bearer && !credLogged) { credLogged = true; log("✓ Spotify session token captured"); } }

  // ---------------------------------------------------------------------------
  // Networking — plain fetch, paced under Spotify's rate limit
  // ---------------------------------------------------------------------------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let paceMs = 450;                 // ≈2.2 req/s ≈130/min — under the ~180/min ceiling
  const PACE_MAX = 1500;
  let lastReqAt = 0;
  async function pace() { const gap = paceMs - (Date.now() - lastReqAt); if (gap > 0) await sleep(gap); lastReqAt = Date.now(); }

  // Serialised, paced request with resilient 429 handling. (A browser usually
  // can't read Retry-After cross-origin, so we lean on proactive pacing +
  // exponential backoff, and bail before Spotify escalates to a long lockout.)
  async function httpPaced(method, url, headers, body) {
    let hit = 0;
    for (;;) {
      await pace();
      let res;
      try { res = await fetch(url, { method, headers, body: body || undefined }); }
      catch (e) { throw new Error("network error"); }
      if (res.status !== 429) return res;
      hit++;
      if (hit > 6) throw new Error("Spotify kept rate-limiting us. Stopping so it doesn't trigger a long lockout — wait a few minutes and Export again.");
      const raHdr = parseInt(res.headers.get("retry-after") || "", 10);
      let waitS = Number.isFinite(raHdr) ? raHdr : Math.min(300, 30 * Math.pow(2, hit - 1));
      if (waitS > 150) throw new Error(`Spotify put a ${waitS}s rate-limit penalty on this session. Stopping — wait a few minutes and try again.`);
      waitS = Math.ceil(waitS * (1 + Math.random() * 0.2));
      paceMs = Math.min(PACE_MAX, paceMs + 200);
      log(`  ⏳ rate limited — waiting ${waitS}s, then continuing slower (${paceMs}ms/request)…`, "bad");
      await sleep(waitS * 1000);
    }
  }

  async function rest(path) {
    const res = await httpPaced("GET", `${API}${path}`, { authorization: `Bearer ${bearer}` });
    if (res.status === 401) throw new Error("token-expired");
    if (res.status === 403) throw new Error("rest-forbidden");
    if (!res.ok) throw new Error(`Spotify ${res.status}`);
    return res.json();
  }
  function normRest(t, albumName) {
    if (!t || t.is_local || !t.id) return null;
    return { id: t.id, name: t.name || "", artists: (t.artists || []).map(a => a.name), album: (t.album && t.album.name) || albumName || "", duration_ms: t.duration_ms || 0, isrc: (t.external_ids && t.external_ids.isrc) || null };
  }
  async function restPageAll(firstPath, label, albumName) {
    const out = []; let path = firstPath;
    while (path) {
      const j = await rest(path);
      for (const item of j.items || []) { const nt = normRest(item.item || item.track || item, albumName); if (nt) out.push(nt); }
      log(`  ${label}: ${out.length}${j.total ? " / " + j.total : ""} songs`);
      path = j.next ? j.next.replace(API, "") : null;
    }
    return out;
  }
  async function restPlaylists() {
    const out = []; let path = "/me/playlists?limit=50";
    while (path) {
      const j = await rest(path);
      for (const p of j.items || []) if (p) out.push({ kind: "playlist", id: p.id, name: p.name, total: ((p.items || p.tracks) || {}).total || 0 });
      log(`  found ${out.length} playlists…`);
      path = j.next ? j.next.replace(API, "") : null;
    }
    return out;
  }
  async function restSavedAlbums() {
    const out = []; let path = "/me/albums?limit=50";
    while (path) {
      const j = await rest(path);
      for (const item of j.items || []) {
        const album = item && item.album;
        if (!album || !album.id) continue;
        const artists = (album.artists || []).map(a => a.name).filter(Boolean);
        out.push({ kind: "album", id: album.id, albumName: album.name || "Untitled", name: `${album.name || "Untitled"}${artists.length ? " — " + artists.join(", ") : ""}`, total: album.total_tracks || ((album.tracks || {}).total) || 0 });
      }
      log(`  found ${out.length} saved albums…`);
      path = j.next ? j.next.replace(API, "") : null;
    }
    return out;
  }
  async function restFollowedArtists() {
    const out = []; let path = "/me/following?type=artist&limit=50";
    while (path) {
      const j = await rest(path), page = j.artists || {};
      for (const artist of page.items || []) if (artist && artist.id) out.push({ kind: "artist", id: artist.id, name: artist.name || "Unknown artist", total: "catalog" });
      log(`  found ${out.length} followed artists…`);
      path = page.next ? page.next.replace(API, "") : null;
    }
    return out;
  }
  async function playlistTracks(source) {
    try { return await restPageAll(`/playlists/${source.id}/items?limit=50`, source.name); }
    catch (e) {
      if (e.message !== "Spotify 404") throw e;
      return restPageAll(`/playlists/${source.id}/tracks?limit=100`, source.name);
    }
  }
  async function albumTracks(source) {
    return restPageAll(`/albums/${source.id}/tracks?limit=50`, source.name, source.albumName || source.name);
  }
  async function artistCatalog(source) {
    const albums = [], seenAlbums = new Set(); let path = `/artists/${source.id}/albums?include_groups=album,single&limit=50`;
    while (path) {
      const page = await rest(path);
      for (const album of page.items || []) if (album && album.id && !seenAlbums.has(album.id)) { seenAlbums.add(album.id); albums.push({ kind: "album", id: album.id, albumName: album.name || "Untitled", name: `${source.name}: ${album.name || "Untitled"}` }); }
      path = page.next ? page.next.replace(API, "") : null;
    }
    const tracks = [], seenTracks = new Set();
    for (const album of albums) {
      for (const track of await albumTracks(album)) if (!seenTracks.has(track.id)) { seenTracks.add(track.id); tracks.push(track); }
    }
    return tracks;
  }

  // Pathfinder fallback (replays the player's own captured library query) ------
  function collectPF(node, out, seen) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(n => collectPF(n, out, seen)); return; }
    const uri = node.uri || (node.data && node.data.uri);
    const isTrack = typeof uri === "string" && uri.indexOf("spotify:track:") === 0;
    if (isTrack) {
      const d = node.data && node.data.uri ? node.data : node;
      const id = uri.split(":").pop();
      if (!seen.has(id)) { seen.add(id); out.push({ id, name: d.name || "", artists: (((d.artists && d.artists.items) || []).map(a => (a.profile && a.profile.name) || a.name).filter(Boolean)), album: (d.albumOfTrack && d.albumOfTrack.name) || (d.album && d.album.name) || "", duration_ms: (d.trackDuration && d.trackDuration.totalMilliseconds) || d.duration_ms || 0, isrc: null }); }
    }
    for (const k in node) if (!(k === "data" && isTrack)) collectPF(node[k], out, seen);
  }
  async function pathfinderLiked(label) {
    if (!pfTemplate) throw new Error("Open your Liked Songs in Spotify once so Segue can learn the query, then Export again.");
    let base; try { base = JSON.parse(pfTemplate.body); } catch (e) { throw new Error("bad pathfinder template"); }
    const out = [], seen = new Set(); let offset = 0; const limit = 100;
    for (let g = 0; g < 500; g++) {
      base.variables = Object.assign({}, base.variables, { offset, limit });
      const res = await httpPaced("POST", pfTemplate.url, { authorization: `Bearer ${bearer}`, "client-token": clientToken || "", "content-type": "application/json", "app-platform": "WebPlayer" }, JSON.stringify(base));
      if (res.status === 401) throw new Error("token-expired");
      if (!res.ok) throw new Error(`pathfinder ${res.status}`);
      const before = out.length; collectPF(await res.json(), out, seen);
      log(`  ${label} (player API): ${out.length} songs`);
      if (out.length === before) break;
      offset += limit;
    }
    return out;
  }
  async function likedTracks() {
    try { return await restPageAll("/me/tracks?limit=50", "Liked Songs"); }
    catch (e) { if (e.message === "token-expired") throw e; log(`  REST refused (${e.message}) → trying the player's own API…`); return await pathfinderLiked("Liked Songs"); }
  }

  async function send(payload) {
    const res = await fetch(`${SEGUE}/api/import/spotify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error("Segue error " + res.status);
    return res.json();
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  const css = `
    #segue-fab{position:fixed;right:20px;bottom:20px;z-index:99999;background:linear-gradient(135deg,#1DB954,#cba6f7);color:#11111b;border:none;border-radius:10px;padding:12px 18px;font:600 14px/1.1 system-ui,sans-serif;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.4);text-align:left}
    #segue-fab small{display:block;font-weight:500;font-size:11px;opacity:.85;margin-top:3px}
    #segue-fab:hover{filter:brightness(1.08)}
    #segue-modal{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center}
    #segue-box{background:#1e1e2e;color:#cdd6f4;border:1px solid #45475a;border-radius:12px;padding:22px;width:520px;max-width:94vw;font:14px/1.5 system-ui,sans-serif}
    #segue-box h3{margin:0 0 4px;font-size:18px}
    #segue-box .sub{color:#a6adc8;margin:0 0 14px;font-size:13px}
    #segue-list{max-height:34vh;overflow:auto;border:1px solid #313244;border-radius:8px;margin-bottom:12px}
    #segue-list label{display:flex;gap:10px;align-items:center;padding:8px 10px;cursor:pointer}
    #segue-list label:nth-child(odd){background:#181825}
    #segue-list .segue-section{padding:7px 10px 4px;background:#313244;color:#a6adc8;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
    #segue-list .n{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #segue-list .c{color:#a6adc8;font-size:12px}
    #segue-log{height:150px;overflow:auto;background:#11111b;border:1px solid #313244;border-radius:8px;padding:8px 10px;font:11.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:#a6adc8;white-space:pre-wrap;margin-bottom:12px}
    #segue-log .t{color:#585b70}#segue-log .ok{color:#a6e3a1}#segue-log .bad{color:#f38ba8}
    .segue-btn{border:none;border-radius:8px;padding:9px 16px;font:600 13px/1 system-ui;cursor:pointer}
    .segue-go{background:#cba6f7;color:#11111b}.segue-go:disabled{opacity:.5;cursor:default}
    .segue-x{background:#313244;color:#cdd6f4;margin-right:8px}
    #segue-status{color:#cdd6f4;font-size:13px;min-height:18px;font-weight:600}
    #segue-diag{margin-top:10px;font:11px/1.5 ui-monospace,monospace;color:#6c7086}
    #segue-diag b{color:#a6e3a1}.segue-diag-bad{color:#f38ba8 !important}
  `;
  function styleOnce() { if (!document.getElementById("segue-style")) { const s = document.createElement("style"); s.id = "segue-style"; s.textContent = css; (document.head || document.documentElement).appendChild(s); } }
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function log(msg, cls) {
    if (!logEl) return;
    const d = new Date(), line = document.createElement("div");
    if (cls) line.className = cls;
    line.innerHTML = `<span class="t">[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]</span> `;
    line.appendChild(document.createTextNode(msg));
    logEl.appendChild(line); logEl.scrollTop = logEl.scrollHeight;
  }
  function diagHtml() { const ok = v => v ? "<b>yes</b>" : "<span class='segue-diag-bad'>no</span>"; return `token: ${ok(bearer)} · client-token: ${ok(clientToken)} · liked-query: ${ok(pfTemplate)}`; }
  function updateBadge() {
    const fab = document.getElementById("segue-fab");
    if (fab) { const s = fab.querySelector("small"); if (s) s.textContent = bearer ? "✓ ready" : "reading session…"; }
    const diag = document.getElementById("segue-diag"); if (diag) diag.innerHTML = diagHtml();
  }
  function fab() {
    if (document.getElementById("segue-fab")) return;
    const b = document.createElement("button");
    b.id = "segue-fab";
    b.innerHTML = "Export to YouTube Music<small>" + (bearer ? "✓ ready" : "reading session…") + "</small>";
    b.onclick = openModal;
    document.body.appendChild(b);
  }

  let modal;
  async function waitForToken(ms) { const t0 = Date.now(); while (!bearer && Date.now() - t0 < ms) await sleep(250); return !!bearer; }

  async function openModal() {
    if (modal) return;
    styleOnce();
    modal = document.createElement("div");
    modal.id = "segue-modal";
    modal.innerHTML = `<div id="segue-box">
      <h3>Export your Spotify library</h3>
      <p class="sub">Pick what to migrate, then Export. Only track details leave your browser — never your login.</p>
      <div id="segue-list"><span style="color:#a6adc8">Preparing…</span></div>
      <div id="segue-log"></div>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span id="segue-status">Getting ready…</span>
        <span><button class="segue-btn segue-x">Close</button><button class="segue-btn segue-go" disabled>Export →</button></span>
      </div>
      <div id="segue-diag">${diagHtml()}</div>
    </div>`;
    document.body.appendChild(modal);
    logEl = modal.querySelector("#segue-log");
    modal.querySelector(".segue-x").onclick = () => { modal.remove(); modal = null; logEl = null; };
    modal.querySelector(".segue-go").onclick = doExport;

    log("Opening Spotify session…");
    if (!bearer) {
      log("Waiting for the web player to hand over a session token…");
      const got = await waitForToken(15000);
      if (!got) { setStatus("Couldn't read your session", true); log("✗ No token yet. Make sure you're logged in (free is fine), then play or click any playlist and reopen this.", "bad"); return; }
    } else { log("✓ Spotify session token ready"); }

    setStatus("Loading your Spotify library…"); log("Fetching playlists, saved albums, and followed artists…");
    const list = modal.querySelector("#segue-list"); list.innerHTML = "";
    list.appendChild(row("liked", "❤ Liked Songs", "", true, { kind: "liked", id: "liked", name: "Liked Songs" }));
    const groups = [
      ["Playlists", restPlaylists],
      ["Saved albums", restSavedAlbums],
      ["Followed artists", restFollowedArtists],
    ];
    for (const [title, load] of groups) {
      try {
        const sources = await load();
        if (sources.length) { const heading = document.createElement("div"); heading.className = "segue-section"; heading.textContent = title; list.appendChild(heading); }
        sources.forEach(source => list.appendChild(row(`${source.kind}:${source.id}`, source.name, source.total, false, source)));
        log(`✓ Loaded ${sources.length} ${title.toLowerCase()}`, "ok");
      } catch (e) { log(`Couldn't list ${title.toLowerCase()} (${e.message}); continuing.`, "bad"); }
    }
    setStatus("Pick what to migrate, then Export →");
    modal.querySelector(".segue-go").disabled = false;
  }

  function setStatus(msg, bad) { const s = modal && modal.querySelector("#segue-status"); if (s) { s.textContent = msg; s.style.color = bad ? "#f38ba8" : "#cdd6f4"; } }
  function row(key, name, count, checked, source) {
    const l = document.createElement("label");
    l.innerHTML = `<input type="checkbox" ${checked ? "checked" : ""}><span class="n"></span><span class="c">${count || ""}</span>`;
    l.querySelector(".n").textContent = name; l.dataset.key = key; l._source = source;
    return l;
  }

  async function doExport() {
    const go = modal.querySelector(".segue-go");
    const rows = [...modal.querySelectorAll("#segue-list label")].filter(l => l.querySelector("input").checked);
    if (!rows.length) { setStatus("Select at least one source.", true); return; }
    go.disabled = true;
    log(`Starting export of ${rows.length} source(s)…`);
    log(`Pacing ~${(1000 / paceMs).toFixed(1)} requests/sec to stay under Spotify's rate limit — big libraries take a little longer, but won't get throttled.`);
    try {
      const payload = { liked: null, playlists: [], albums: [], artists: [] };
      for (const r of rows) {
        const source = r._source;
        if (source.kind === "liked") {
          setStatus("Exporting Liked Songs…"); log("Exporting Liked Songs…");
          payload.liked = { name: "Liked Songs", tracks: await likedTracks() };
          log(`✓ Liked Songs: ${payload.liked.tracks.length} songs`, "ok");
        } else if (source.kind === "playlist") {
          setStatus(`Exporting “${source.name}”…`); log(`Exporting playlist “${source.name}”…`);
          const tracks = await playlistTracks(source);
          payload.playlists.push({ id: source.id, name: source.name, tracks });
          log(`✓ “${source.name}”: ${tracks.length} songs`, "ok");
        } else if (source.kind === "album") {
          setStatus(`Exporting album “${source.name}”…`); log(`Exporting album “${source.name}”…`);
          const tracks = await albumTracks(source);
          payload.albums.push({ id: source.id, name: source.name, tracks });
          log(`✓ “${source.name}”: ${tracks.length} songs`, "ok");
        } else if (source.kind === "artist") {
          setStatus(`Exporting ${source.name}'s catalog…`); log(`Exporting followed artist “${source.name}”…`);
          const tracks = await artistCatalog(source);
          payload.artists.push({ id: source.id, name: `${source.name} — catalog`, tracks });
          log(`✓ “${source.name}”: ${tracks.length} unique catalog songs`, "ok");
        }
      }
      const count = (payload.liked ? payload.liked.tracks.length : 0) + [payload.playlists, payload.albums, payload.artists].flat().reduce((n, source) => n + source.tracks.length, 0);
      if (!count) { setStatus("Nothing exported — see the log.", true); go.disabled = false; return; }
      setStatus(`Sending ${count} songs to Segue…`); log(`Sending ${count} songs to Segue…`);
      const res = await send(payload);
      setStatus(`Done — ${res.count} songs. Opening Segue…`); log(`✓ Done. Opening Segue in a new tab.`, "ok");
      window.open(`${SEGUE}/#import=${res.import_id}`, "_blank");
      setTimeout(() => { if (modal) { modal.remove(); modal = null; logEl = null; } }, 2500);
    } catch (e) {
      const msg = e.message === "token-expired" ? "Session expired — refresh Spotify and retry." : e.message;
      setStatus("Error: " + msg, true); log("✗ " + msg, "bad"); go.disabled = false;
    }
  }

  // Boot
  installHooks();
  const boot = setInterval(() => { if (document.body) { styleOnce(); fab(); updateBadge(); clearInterval(boot); } }, 400);
})();
