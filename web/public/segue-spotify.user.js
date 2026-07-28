// ==UserScript==
// @name         Segue — Spotify → YouTube Music exporter
// @namespace    https://segue.getparkerai.com
// @version      0.4.0
// @description  Export your Spotify playlists & liked songs (no developer app, no Premium) and send them to Segue to migrate to YouTube Music.
// @author       SysAdminDoc
// @match        https://open.spotify.com/*
// @icon         https://open.spotify.com/favicon.ico
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      api.spotify.com
// @connect      api-partner.spotify.com
// @connect      segue.getparkerai.com
// @run-at       document-start
// @downloadURL  https://segue.getparkerai.com/segue-spotify.user.js
// @updateURL    https://segue.getparkerai.com/segue-spotify.user.js
// ==/UserScript==

/*
 * WHY v0.4.0:
 *  - v0.2 failed: the fetch hook ran in the userscript sandbox, not the page.
 *  - v0.3 failed: injecting the hook via an inline <script> is blocked by
 *    Spotify's Content-Security-Policy, so it never installed.
 *  - v0.4 patches the page's real fetch/XHR directly through `unsafeWindow`
 *    (no inline script — CSP can't block it) and captures the bearer +
 *    client-token the web player already mints (so there's no TOTP to solve).
 * Plus a live verbose log so a big library never looks "stuck".
 * Your Spotify login never leaves the browser — only track metadata is sent.
 */
(function () {
  "use strict";
  const SEGUE = "https://segue.getparkerai.com";
  const API = "https://api.spotify.com/v1";
  const W = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;

  let bearer = null, clientToken = null, pfTemplate = null;
  let logEl = null;

  // ---------------------------------------------------------------------------
  // Capture the web-player's token by patching the PAGE's fetch/XHR via unsafeWindow
  // ---------------------------------------------------------------------------
  function installHooks() {
    if (W.__segueHooked) return;
    W.__segueHooked = true;

    const oFetch = W.fetch;
    W.fetch = function (input, init) {
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

    const XHR = W.XMLHttpRequest;
    const oOpen = XHR.prototype.open;
    const oSet = XHR.prototype.setRequestHeader;
    const oSend = XHR.prototype.send;
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
  function onCred() {
    updateBadge();
    if (bearer && !credLogged) { credLogged = true; log("✓ Spotify session token captured"); }
  }

  // ---------------------------------------------------------------------------
  // Networking (all through GM_xmlhttpRequest — no CORS)
  // ---------------------------------------------------------------------------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function gm(method, url, headers, data) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({ method, url, headers, data, timeout: 30000,
        onload: r => resolve(r), onerror: () => reject(new Error("network error")), ontimeout: () => reject(new Error("timeout")) });
    });
  }
  async function rest(path) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const r = await gm("GET", `${API}${path}`, { authorization: `Bearer ${bearer}` });
      if (r.status === 429) { const ra = parseInt((r.responseHeaders.match(/retry-after:\s*(\d+)/i) || [])[1] || "2", 10); log(`  …rate-limited, waiting ${ra + 1}s`); await sleep((ra + 1) * 1000); continue; }
      if (r.status === 401) throw new Error("token-expired");
      if (r.status === 403) throw new Error("rest-forbidden");
      if (r.status < 200 || r.status >= 300) throw new Error(`Spotify ${r.status}`);
      return JSON.parse(r.responseText);
    }
    throw new Error("rate-limited");
  }
  function normRest(t) {
    if (!t || t.is_local || !t.id) return null;
    return { id: t.id, name: t.name || "", artists: (t.artists || []).map(a => a.name), album: (t.album && t.album.name) || "", duration_ms: t.duration_ms || 0, isrc: (t.external_ids && t.external_ids.isrc) || null };
  }
  async function restPageAll(firstPath, label) {
    const out = []; let path = firstPath, page = 0;
    while (path) {
      const j = await rest(path); page++;
      for (const item of j.items || []) { const nt = normRest(item.track || item); if (nt) out.push(nt); }
      log(`  ${label}: ${out.length}${j.total ? " / " + j.total : ""} songs`);
      path = j.next ? j.next.replace(API, "") : null;
    }
    return out;
  }
  async function restPlaylists() {
    const out = []; let path = "/me/playlists?limit=50";
    while (path) {
      const j = await rest(path);
      for (const p of j.items || []) if (p) out.push({ id: p.id, name: p.name, total: (p.tracks || {}).total || 0 });
      log(`  found ${out.length} playlists…`);
      path = j.next ? j.next.replace(API, "") : null;
    }
    return out;
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
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ id, name: d.name || "", artists: (((d.artists && d.artists.items) || []).map(a => (a.profile && a.profile.name) || a.name).filter(Boolean)), album: (d.albumOfTrack && d.albumOfTrack.name) || (d.album && d.album.name) || "", duration_ms: (d.trackDuration && d.trackDuration.totalMilliseconds) || d.duration_ms || 0, isrc: null });
      }
    }
    for (const k in node) if (!(k === "data" && isTrack)) collectPF(node[k], out, seen);
  }
  async function pathfinderLiked(label) {
    if (!pfTemplate) throw new Error("Open your Liked Songs in Spotify once so Segue can learn the query, then Export again.");
    let base; try { base = JSON.parse(pfTemplate.body); } catch (e) { throw new Error("bad pathfinder template"); }
    const out = [], seen = new Set(); let offset = 0; const limit = 100;
    for (let g = 0; g < 500; g++) {
      base.variables = Object.assign({}, base.variables, { offset, limit });
      const r = await gm("POST", pfTemplate.url, { authorization: `Bearer ${bearer}`, "client-token": clientToken || "", "content-type": "application/json", "app-platform": "WebPlayer" }, JSON.stringify(base));
      if (r.status === 401) throw new Error("token-expired");
      if (r.status !== 200) throw new Error(`pathfinder ${r.status}`);
      const before = out.length; collectPF(JSON.parse(r.responseText), out, seen);
      log(`  ${label} (player API): ${out.length} songs`);
      if (out.length === before) break;
      offset += limit;
    }
    return out;
  }
  async function likedTracks() {
    try { return await restPageAll("/me/tracks?limit=50", "Liked Songs"); }
    catch (e) {
      if (e.message === "token-expired") throw e;
      log(`  REST refused (${e.message}) → trying the player's own API…`);
      return await pathfinderLiked("Liked Songs");
    }
  }

  function send(payload) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({ method: "POST", url: `${SEGUE}/api/import/spotify`, headers: { "Content-Type": "application/json" }, data: JSON.stringify(payload),
        onload: r => { try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(new Error("Bad response from Segue")); } }, onerror: () => reject(new Error("Could not reach Segue")) });
    });
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
  function styleOnce() { if (!document.getElementById("segue-style")) { const s = document.createElement("style"); s.id = "segue-style"; s.textContent = css; document.head.appendChild(s); } }

  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function log(msg, cls) {
    if (!logEl) return;
    const d = new Date();
    const line = document.createElement("div");
    if (cls) line.className = cls;
    line.innerHTML = `<span class="t">[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]</span> `;
    line.appendChild(document.createTextNode(msg));
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function diagHtml() {
    const ok = v => v ? "<b>yes</b>" : "<span class='segue-diag-bad'>no</span>";
    return `token: ${ok(bearer)} · client-token: ${ok(clientToken)} · liked-query: ${ok(pfTemplate)}`;
  }
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
      if (!got) {
        setStatus("Couldn't read your session", true);
        log("✗ No token yet. Make sure you're logged in (free is fine), then play or click any playlist and reopen this.", "bad");
        return;
      }
    } else { log("✓ Spotify session token ready"); }

    setStatus("Loading your playlists…");
    log("Fetching your playlists…");
    try {
      const pls = await restPlaylists();
      const list = modal.querySelector("#segue-list");
      list.innerHTML = "";
      list.appendChild(row("liked", "❤ Liked Songs", "", true));
      pls.forEach(p => list.appendChild(row("pl:" + p.id, p.name, p.total, false, p)));
      log(`✓ Loaded ${pls.length} playlists`, "ok");
      setStatus("Pick what to migrate, then Export →");
      modal.querySelector(".segue-go").disabled = false;
    } catch (e) {
      log(`Couldn't list playlists (${e.message}). Liked Songs may still work.`, "bad");
      const list = modal.querySelector("#segue-list");
      list.innerHTML = ""; list.appendChild(row("liked", "❤ Liked Songs", "", true));
      setStatus("Pick what to migrate, then Export →");
      modal.querySelector(".segue-go").disabled = false;
    }
  }

  function setStatus(msg, bad) { const s = modal && modal.querySelector("#segue-status"); if (s) { s.textContent = msg; s.style.color = bad ? "#f38ba8" : "#cdd6f4"; } }
  function row(key, name, count, checked, pl) {
    const l = document.createElement("label");
    l.innerHTML = `<input type="checkbox" ${checked ? "checked" : ""}><span class="n"></span><span class="c">${count || ""}</span>`;
    l.querySelector(".n").textContent = name; l.dataset.key = key; if (pl) l._pl = pl;
    return l;
  }

  async function doExport() {
    const go = modal.querySelector(".segue-go");
    const rows = [...modal.querySelectorAll("#segue-list label")].filter(l => l.querySelector("input").checked);
    if (!rows.length) { setStatus("Select at least one source.", true); return; }
    go.disabled = true;
    log(`Starting export of ${rows.length} source(s)…`);
    try {
      const payload = { liked: null, playlists: [] };
      for (const r of rows) {
        if (r.dataset.key === "liked") {
          setStatus("Exporting Liked Songs…"); log("Exporting Liked Songs…");
          payload.liked = { name: "Liked Songs", tracks: await likedTracks() };
          log(`✓ Liked Songs: ${payload.liked.tracks.length} songs`, "ok");
        } else {
          const pl = r._pl;
          setStatus(`Exporting “${pl.name}”…`); log(`Exporting playlist “${pl.name}”…`);
          const tracks = await restPageAll(`/playlists/${pl.id}/tracks?limit=100`, pl.name);
          payload.playlists.push({ id: pl.id, name: pl.name, tracks });
          log(`✓ “${pl.name}”: ${tracks.length} songs`, "ok");
        }
      }
      const count = (payload.liked ? payload.liked.tracks.length : 0) + payload.playlists.reduce((n, p) => n + p.tracks.length, 0);
      if (!count) { setStatus("Nothing exported — see the log.", true); go.disabled = false; return; }
      setStatus(`Sending ${count} songs to Segue…`); log(`Sending ${count} songs to Segue…`);
      const res = await send(payload);
      setStatus(`Done — ${res.count} songs. Opening Segue…`); log(`✓ Done. Opening Segue in a new tab.`, "ok");
      W.open(`${SEGUE}/#import=${res.import_id}`, "_blank");
      setTimeout(() => { if (modal) { modal.remove(); modal = null; logEl = null; } }, 2500);
    } catch (e) {
      const msg = e.message === "token-expired" ? "Session expired — refresh Spotify and retry." : e.message;
      setStatus("Error: " + msg, true); log("✗ " + msg, "bad");
      go.disabled = false;
    }
  }

  // Boot
  installHooks();
  const boot = setInterval(() => { if (document.body) { styleOnce(); fab(); updateBadge(); clearInterval(boot); } }, 400);
})();
