// ==UserScript==
// @name         Segue — Spotify → YouTube Music exporter
// @namespace    https://segue.getparkerai.com
// @version      0.2.0
// @description  Export your Spotify playlists & liked songs (no developer app, no Premium) and send them to Segue to migrate to YouTube Music.
// @author       SysAdminDoc
// @match        https://open.spotify.com/*
// @icon         https://open.spotify.com/favicon.ico
// @grant        GM_xmlhttpRequest
// @connect      segue.getparkerai.com
// @run-at       document-start
// @downloadURL  https://segue.getparkerai.com/segue-spotify.user.js
// @updateURL    https://segue.getparkerai.com/segue-spotify.user.js
// ==/UserScript==

/*
 * How it works: the Spotify Web Player (which works for FREE accounts) constantly
 * makes authenticated calls to api.spotify.com with a short-lived bearer token.
 * This script hooks fetch/XHR to capture that token, then reuses it to page
 * through your own library — the same data the player already shows you. Nothing
 * here needs a Spotify developer app, a Client ID, or Premium. Your token never
 * leaves your browser; only the resulting track list (name/artist/album/ISRC) is
 * sent to Segue for matching.
 */
(function () {
  "use strict";
  const SEGUE = "https://segue.getparkerai.com";
  const API = "https://api.spotify.com/v1";
  let bearer = null;

  // --- capture the web player's bearer token -------------------------------
  const origFetch = window.fetch;
  function grab(v) {
    if (typeof v === "string" && v.indexOf("Bearer ") === 0) bearer = v.slice(7);
  }
  function scanHeaders(h) {
    try {
      if (!h) return;
      if (typeof h.get === "function") { grab(h.get("authorization") || h.get("Authorization")); return; }
      if (Array.isArray(h)) { h.forEach(p => { if (String(p[0]).toLowerCase() === "authorization") grab(p[1]); }); return; }
      Object.keys(h).forEach(k => { if (k.toLowerCase() === "authorization") grab(h[k]); });
    } catch (e) { /* ignore */ }
  }
  window.fetch = function (input, init) {
    if (init) scanHeaders(init.headers);
    if (input && typeof input === "object") scanHeaders(input.headers);
    return origFetch.apply(this, arguments);
  };
  const origOpen = XMLHttpRequest.prototype.open;
  const origSet = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (String(k).toLowerCase() === "authorization") grab(String(v));
    return origSet.apply(this, arguments);
  };
  XMLHttpRequest.prototype.open = function () { return origOpen.apply(this, arguments); };

  // --- helpers -------------------------------------------------------------
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function sp(path) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const res = await origFetch(`${API}${path}`, { headers: { authorization: `Bearer ${bearer}` } });
      if (res.status === 429) { await sleep((parseInt(res.headers.get("retry-after") || "2", 10) + 1) * 1000); continue; }
      if (res.status === 401) throw new Error("token-expired");
      if (!res.ok) throw new Error(`Spotify API ${res.status}`);
      return res.json();
    }
    throw new Error("rate-limited");
  }

  function normTrack(t) {
    if (!t || t.is_local || !t.id) return null;
    return {
      id: t.id,
      name: t.name || "",
      artists: (t.artists || []).map(a => a.name),
      album: (t.album && t.album.name) || "",
      duration_ms: t.duration_ms || 0,
      isrc: (t.external_ids && t.external_ids.isrc) || null,
    };
  }

  async function pageAll(firstPath, onProgress) {
    const out = [];
    let path = firstPath;
    while (path) {
      const page = await sp(path);
      for (const item of page.items || []) {
        const nt = normTrack(item.track || item);
        if (nt) out.push(nt);
      }
      if (onProgress) onProgress(out.length, page.total || 0);
      const next = page.next ? page.next.replace(API, "") : null;
      path = next;
    }
    return out;
  }

  async function listPlaylists() {
    const out = [];
    let path = "/me/playlists?limit=50";
    while (path) {
      const page = await sp(path);
      for (const p of page.items || []) {
        if (p) out.push({ id: p.id, name: p.name, total: (p.tracks || {}).total || 0 });
      }
      path = page.next ? page.next.replace(API, "") : null;
    }
    return out;
  }

  function send(payload) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: `${SEGUE}/api/import/spotify`,
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify(payload),
        onload: r => {
          try { resolve(JSON.parse(r.responseText)); }
          catch (e) { reject(new Error("Bad response from Segue")); }
        },
        onerror: () => reject(new Error("Could not reach Segue")),
      });
    });
  }

  // --- UI ------------------------------------------------------------------
  const css = `
    #segue-fab{position:fixed;right:20px;bottom:20px;z-index:99999;background:linear-gradient(135deg,#1DB954,#cba6f7);
      color:#11111b;border:none;border-radius:10px;padding:12px 18px;font:600 14px/1 system-ui,sans-serif;
      cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.4)}
    #segue-fab:hover{filter:brightness(1.08)}
    #segue-modal{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center}
    #segue-box{background:#1e1e2e;color:#cdd6f4;border:1px solid #45475a;border-radius:12px;padding:22px;width:440px;max-width:92vw;font:14px/1.5 system-ui,sans-serif}
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
  `;
  function styleOnce() { if (!document.getElementById("segue-style")) { const s = document.createElement("style"); s.id = "segue-style"; s.textContent = css; document.head.appendChild(s); } }

  function fab() {
    if (document.getElementById("segue-fab")) return;
    const b = document.createElement("button");
    b.id = "segue-fab"; b.textContent = "Export to YouTube Music";
    b.onclick = openModal;
    document.body.appendChild(b);
  }

  let modal;
  async function openModal() {
    styleOnce();
    if (!bearer) { alert("Segue: still reading your session — click a playlist or your Library once, then try again."); return; }
    modal = document.createElement("div");
    modal.id = "segue-modal";
    modal.innerHTML = `<div id="segue-box">
      <h3>Export your Spotify library</h3>
      <p class="sub">Pick what to migrate. Only track details leave your browser — never your login.</p>
      <div id="segue-list">Loading your playlists…</div>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span id="segue-status"></span>
        <span><button class="segue-btn segue-x">Cancel</button><button class="segue-btn segue-go">Export →</button></span>
      </div></div>`;
    document.body.appendChild(modal);
    modal.querySelector(".segue-x").onclick = () => modal.remove();
    modal.querySelector(".segue-go").onclick = doExport;

    try {
      const pls = await listPlaylists();
      const list = modal.querySelector("#segue-list");
      list.innerHTML = "";
      list.appendChild(row("liked", "❤ Liked Songs", "", true));
      pls.forEach(p => list.appendChild(row("pl:" + p.id, p.name, p.total, false, p)));
    } catch (e) {
      modal.querySelector("#segue-list").textContent = "Couldn't load playlists: " + e.message;
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
          const tracks = await pageAll("/me/tracks?limit=50", n => status.textContent = `Liked Songs… ${n}`);
          payload.liked = { name: "Liked Songs", tracks };
        } else {
          const pl = r._pl;
          status.textContent = `Exporting “${pl.name}”…`;
          const tracks = await pageAll(`/playlists/${pl.id}/tracks?limit=100`, n => status.textContent = `${pl.name}… ${n}`);
          payload.playlists.push({ id: pl.id, name: pl.name, tracks });
        }
      }
      status.textContent = "Sending to Segue…";
      const res = await send(payload);
      status.textContent = `Done — ${res.count} songs. Opening Segue…`;
      window.open(`${SEGUE}/#import=${res.import_id}`, "_blank");
      setTimeout(() => modal.remove(), 1500);
    } catch (e) {
      status.textContent = "Error: " + (e.message === "token-expired" ? "session expired — refresh Spotify and retry." : e.message);
      modal.querySelector(".segue-go").disabled = false;
    }
  }

  // Boot: add the button once the player DOM exists.
  const boot = setInterval(() => { if (document.body) { styleOnce(); fab(); clearInterval(boot); } }, 500);
})();
