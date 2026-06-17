const $ = (s) => document.querySelector(s);
const wrap = $("#wrap"), input = $("#input"), sendBtn = $("#send");
let history = [];
let busy = false;
let armed = false;
let chatServer = null;      // null = the local controller box; else a remote agent id
let chatServerName = "";
let fleetCanChat = false;   // controller's AI backend can drive remote boxes
let isController = false;    // this instance manages a fleet (vs a standalone box)
let fleetJoinToken = "";     // join token agents present at enrollment
let fleetMesh = false;       // controller is running a self-hosted WireGuard mesh
let lastStatus = null;
const cpuHist = [], memHist = [];   // rolling samples for sparklines

// ─── view switching + URL (hash) routing + mobile drawer ─────────────────────────
const VIEWS = ["overview", "fleet", "assistant", "tools", "settings"];
const viewFromHash = () => { const h = location.hash.slice(1); return VIEWS.includes(h) ? h : "overview"; };
function showView(name) {
  if (!VIEWS.includes(name)) name = "overview";
  document.querySelectorAll("[data-view]").forEach((v) => {
    const on = v.dataset.view === name;
    v.classList.toggle("hidden", !on);
    v.classList.toggle("flex", on && name === "assistant");
  });
  document.querySelectorAll("[data-nav]").forEach((n) => n.classList.toggle("active", n.dataset.nav === name));
  $("#pageTitle").textContent = name === "assistant" ? "Chat" : name === "settings" ? "Settings" : name === "tools" ? "Tools" : name === "fleet" ? "Fleet" : (isController ? "This server" : "Overview");
  if (location.hash.slice(1) !== name) location.hash = name; // each view has its own URL: bookmarkable, back/forward works
  if (name === "assistant") { renderChatEmpty(); setTimeout(() => input.focus(), 30); }
  if (name === "settings") loadSettings();
  if (name === "tools") loadTools();
  if (name === "fleet") loadFleet();
  closeDrawer();
}
document.querySelectorAll("[data-nav]").forEach((n) => n.onclick = () => showView(n.dataset.nav));
// Back/forward buttons and direct URLs change the view — but only when signed in.
addEventListener("hashchange", () => { if (!$("#gate").classList.contains("flex")) showView(viewFromHash()); });
function openDrawer() { $("#sidebar").classList.add("open"); $("#overlay").classList.remove("hidden"); }
function closeDrawer() { $("#sidebar").classList.remove("open"); $("#overlay").classList.add("hidden"); }
$("#hamburger").onclick = openDrawer;
$("#overlay").onclick = closeDrawer;

// ─── arm toggle ─────────────────────────────────────────────────────────────────
function renderArm() {
  const b = $("#arm");
  b.classList.toggle("on", armed);
  b.setAttribute("aria-pressed", armed ? "true" : "false");
  b.innerHTML = `<span class="toggle-track"><span class="toggle-knob"></span></span><span class="toggle-label">${armed ? "Mutations On" : "Mutations Off"}</span>`;
}
$("#arm").onclick = async () => {
  const want = !armed, b = $("#arm");
  b.disabled = true;
  try { const r = await fetch("/auth/arm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: want, server: chatServer || undefined }) }); if (r.ok) { const d = await r.json(); armed = !!d.armed; } } catch {}
  b.disabled = false; renderArm();
};

const SUGGESTIONS = ["Is Redis healthy?", "Show me PM2 processes", "How much disk space is left?", "What's listening on port 80?", "Why might nginx be down?"];

// ─── auth gate ──────────────────────────────────────────────────────────────────
function showGate(msg) { $("#gate").classList.remove("hidden"); $("#gate").classList.add("flex"); $("#gateErr").textContent = msg || ""; $("#password").focus(); }
function hideGate() { $("#gate").classList.add("hidden"); $("#gate").classList.remove("flex"); }
$("#connect").onclick = connect;
$("#password").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#totp").focus(); });
$("#totp").addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });
async function connect() {
  const password = $("#password").value, totp = $("#totp").value.trim();
  if (!password || !totp) return showGate("Enter both password and code.");
  $("#gateErr").textContent = "…";
  try {
    const r = await fetch("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password, totp }) });
    if (r.ok) { $("#password").value = ""; $("#totp").value = ""; hideGate(); loadStatus(); fetch("/auth/me").then((x) => x.json()).then(afterAuth).catch(() => showView("overview")); return; }
    const data = await r.json().catch(() => ({}));
    if (r.status === 503) return showGate("Auth not set up — run `bun run setup-auth` on the server.");
    if (r.status === 429) return showGate(`Locked out — try again in ${data.retryAfterSec || 60}s.`);
    showGate(data.error || "Invalid credentials.");
  } catch (e) { showGate("Connection failed: " + e.message); }
}
$("#logout").onclick = async () => { try { await fetch("/auth/logout", { method: "POST" }); } catch {} history = []; wrap.innerHTML = ""; chatServer = null; chatServerName = ""; renderChatContext(); showGate(""); };

// ─── formatting + sparkline ─────────────────────────────────────────────────────
function fmtBytes(n) { if (!n || n < 0) return "0 B"; const u = ["B", "KB", "MB", "GB", "TB"]; let i = Math.floor(Math.log(n) / Math.log(1024)); i = Math.min(i, u.length - 1); return (n / 1024 ** i).toFixed(i ? 1 : 0) + " " + u[i]; }
function fmtUptime(ms) { if (!ms) return "—"; const s = Math.floor((Date.now() - ms) / 1000); const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; }
function tone(pct) { return pct >= 90 ? "bad" : pct >= 70 ? "warn" : "ok"; }

// Collapse a verbose "18 weeks, 5 days, 1 hour…" into the two largest units,
// e.g. "18w 5d", so the Uptime card never wraps. Full string lives in the sub.
function compactUptime(s) {
  if (!s || s === "—") return { big: "—", full: "" };
  const u = { week: "w", day: "d", hour: "h", minute: "m", min: "m", second: "s" };
  const parts = []; let m; const re = /(\d+)\s*(week|day|hour|minute|min|second)s?/gi;
  while ((m = re.exec(s))) parts.push(m[1] + (u[m[2].toLowerCase()] || ""));
  return { big: parts.slice(0, 2).join(" ") || s, full: s };
}

// Area sparkline: a filled trend with a soft gradient under the line. Each call
// mints a unique gradient id so multiple cards don't collide.
let sparkSeq = 0;
function spark(vals, w = 240, h = 52) {
  if (!vals || vals.length < 2) return "";
  const id = "spk" + (++sparkSeq);
  const max = Math.max(...vals), min = Math.min(...vals), rng = (max - min) || 1, step = w / (vals.length - 1);
  const pts = vals.map((v, i) => `${(i * step).toFixed(1)},${(h - 4 - ((v - min) / rng) * (h - 12)).toFixed(1)}`);
  const line = pts.join(" ");
  return `<svg class="spark-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="currentColor" stop-opacity=".26"/>
      <stop offset="1" stop-color="currentColor" stop-opacity="0"/>
    </linearGradient></defs>
    <polygon points="0,${h} ${line} ${w},${h}" fill="url(#${id})"/>
    <polyline points="${line}" fill="none" stroke="currentColor" stroke-width="1.75"
      stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function kpiCard(o) {
  const tone = o.tone || "accent";
  let chart = "";
  if (o.sparkVals && o.sparkVals.length > 1) chart = `<div class="metric-spark">${spark(o.sparkVals)}</div>`;
  else if (o.gauge != null) chart = `<div class="metric-gauge${o.gaugeUp ? " up" : ""}"><i style="width:${Math.min(o.gauge, 100)}%"></i></div>`;
  return `<div class="metric-card" data-tone="${tone}">
    <div class="metric-top"><span class="metric-label">${o.label}</span><span class="metric-icon">${o.icon || ""}</span></div>
    <div class="metric-value mono">${o.value}</div>
    <div class="metric-sub mono">${o.sub || ""}</div>
    <div class="metric-chart">${chart}</div>
  </div>`;
}

// metric glyphs (line icons, set in currentColor)
const ICONS = {
  cpu:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M20 9h2M20 14h2M2 9h2M2 14h2"/></svg>`,
  mem:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="8" rx="1"/><path d="M7 8V6M12 8V6M17 8V6M7 18v-2M12 18v-2M17 18v-2"/></svg>`,
  disk: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/></svg>`,
  up:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/></svg>`,
};

// ─── skeleton loading ────────────────────────────────────────────────────────────
function showSkeletons() {
  if (lastStatus) return;   // only before the first real payload — never flicker on refresh
  $("#statusHero").innerHTML = `<div class="status-hero skeleton-card"><span class="sk sk-dot"></span><span class="sk sk-line" style="max-width:220px"></span></div>`;
  $("#kpis").innerHTML = Array.from({ length: 4 }, () => `
    <div class="metric-card skeleton-card">
      <div class="metric-top"><span class="sk sk-label"></span><span class="sk sk-icon"></span></div>
      <span class="sk sk-value"></span>
      <span class="sk sk-sub"></span>
      <span class="sk sk-chart"></span>
    </div>`).join("");
  $("#healthGrid").innerHTML = Array.from({ length: 6 }, () => `
    <div class="service-card skeleton-card"><span class="sk sk-dot"></span><span class="sk sk-line"></span></div>`).join("");
  $("#pm2Body").innerHTML = Array.from({ length: 4 }, () => `
    <tr class="skeleton-row">
      <td><span class="sk sk-line"></span></td>
      <td><span class="sk sk-pill"></span></td>
      <td class="r"><span class="sk sk-num"></span></td>
      <td class="r"><span class="sk sk-num"></span></td>
      <td class="r"><span class="sk sk-num"></span></td>
      <td class="r"><span class="sk sk-num"></span></td>
    </tr>`).join("");
}

// ─── status / dashboard ──────────────────────────────────────────────────────────
$("#refresh").onclick = loadStatus;
async function loadStatus() {
  showSkeletons();
  try {
    const r = await fetch("/status");
    if (r.status === 401) return showGate("Session expired — sign in again.");
    if (!r.ok) return;
    lastStatus = await r.json();
    renderDashboard(lastStatus);
  } catch (e) { /* keep last */ }
}

function renderDashboard(s) {
  const m = s.metrics || {};
  const host = s.host || {};
  $("#hostName").textContent = (isController ? "Controller · " : "") + (host.hostname || "—");

  // sparkline history
  const cpuPct = m.cpu && m.cpu.cores ? Math.min(Math.round((m.cpu.load1 / m.cpu.cores) * 100), 100) : null;
  if (cpuPct != null) { cpuHist.push(cpuPct); if (cpuHist.length > 40) cpuHist.shift(); }
  if (m.memory) { memHist.push(m.memory.usedPct); if (memHist.length > 40) memHist.shift(); }

  // KPI cards — CPU/Memory show a trend sparkline; Disk a usage gauge; Uptime a green "up" bar.
  const cards = [];
  if (m.cpu) {
    cards.push(kpiCard({ label: "CPU Load", value: (m.cpu.load1 ?? 0).toFixed(2), sub: `${m.cpu.cores} cores · ${cpuPct ?? 0}%`, tone: tone(cpuPct ?? 0), icon: ICONS.cpu, sparkVals: cpuHist.slice() }));
  }
  if (m.memory) {
    cards.push(kpiCard({ label: "Memory", value: m.memory.usedPct + "%", sub: `${fmtBytes(m.memory.usedBytes)} / ${fmtBytes(m.memory.totalBytes)}`, tone: tone(m.memory.usedPct), icon: ICONS.mem, sparkVals: memHist.slice() }));
  }
  if (m.disk) {
    cards.push(kpiCard({ label: "Disk (" + (m.disk.mount || "/") + ")", value: m.disk.usedPct + "%", sub: `${fmtBytes(m.disk.usedBytes)} / ${fmtBytes(m.disk.sizeBytes)}`, tone: tone(m.disk.usedPct), icon: ICONS.disk, gauge: m.disk.usedPct }));
  }
  const ut = compactUptime((host.uptime || "—").replace(/^up\s*/, ""));
  cards.push(kpiCard({ label: "Uptime", value: ut.big, sub: ut.full || host.hostname || "", icon: ICONS.up, gauge: 100, gaugeUp: true }));
  $("#kpis").innerHTML = cards.join("");

  // service health grid (tri-state: up / warn / down)
  const svc = [];
  for (const [name, st] of Object.entries(s.services || {})) {
    if (st === "unknown" || st === "") continue;
    svc.push([name, st === "active" ? "up" : st === "inactive" ? "warn" : "down", st]);
  }
  if (s.redis) svc.push(["redis", s.redis.connected ? "up" : "down", s.redis.connected ? (s.redis.usedMemoryHuman || "connected") : "down"]);
  if (s.mysql) svc.push(["mysql", s.mysql.ok ? "up" : "down", s.mysql.ok ? "connected" : "down"]);
  if (s.pm2) { const n = Array.isArray(s.pm2.processes) ? s.pm2.processes.length : null; svc.push(["pm2", s.pm2.ok ? "up" : "down", s.pm2.ok ? (n != null ? n + " online" : "ok") : "down"]); }

  // problems first: down, then warn, then healthy — so trouble lands top-left
  const rank = { down: 0, warn: 1, up: 2 };
  const downs = svc.filter(([, st]) => st === "down");
  const warns = svc.filter(([, st]) => st === "warn");
  svc.sort((a, b) => rank[a[1]] - rank[b[1]]);

  // ── system status hero: the one-glance answer to "is my server OK?" ──
  let hState = "ok", hTitle = "All systems operational",
      hMeta = `${svc.length} service${svc.length !== 1 ? "s" : ""} monitored · ${host.hostname || "server"}`;
  if (downs.length) {
    hState = "down";
    hTitle = downs.length === 1 ? "1 service needs attention" : `${downs.length} services need attention`;
    hMeta = downs.map((d) => d[0]).join(", ") + " down · " + (host.hostname || "server");
  } else if (warns.length) {
    hState = "warn";
    hTitle = "Operational with warnings";
    hMeta = warns.map((w) => w[0]).join(", ") + " inactive · " + (host.hostname || "server");
  }
  const sides = [];
  if (m.cpu) sides.push(`<span class="sh-stat"><b>${m.cpu.cores}</b> cores</span>`);
  if (m.memory) sides.push(`<span class="sh-stat"><b>${fmtBytes(m.memory.totalBytes)}</b> RAM</span>`);
  if (ut.big !== "—") sides.push(`<span class="sh-stat"><b>${ut.big}</b> uptime</span>`);
  $("#statusHero").innerHTML = `<div class="status-hero" data-state="${hState}">
    <span class="sh-dot"></span>
    <div class="sh-text"><div class="sh-title">${esc(hTitle)}</div><div class="sh-meta">${esc(hMeta)}</div></div>
    <div class="sh-side">${sides.join("")}<span class="sh-updated">Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>
  </div>`;

  $("#svcTitle") && ($("#svcTitle").textContent = `Services · ${svc.length}`);

  $("#healthGrid").innerHTML = svc.map(([name, state, detail]) => `
    <div class="service-card ${state === "down" ? "down" : ""}">
      <span class="service-glow"><span class="service-dot ${state}"></span></span>
      <div class="service-info">
        <div class="service-name">${esc(name)}</div>
        <div class="service-status">${esc(String(detail))}</div>
      </div>
    </div>`).join("") || `<div class="empty">No service data.</div>`;

  // pm2 table
  const procs = Array.isArray(s.pm2 && s.pm2.processes) ? s.pm2.processes : [];
  $("#pm2Title") && ($("#pm2Title").textContent = `PM2 Processes · ${procs.length}`);
  $("#pm2Body").innerHTML = procs.length ? procs.map((p) => {
    const online = p.status === "online";
    return `<tr>
      <td class="name">${esc(p.name || "?")}</td>
      <td><span class="status-pill ${online ? "online" : "offline"}"><span class="pd"></span>${esc(p.status || "?")}</span></td>
      <td class="r num">${p.cpu ?? 0}%</td>
      <td class="r num">${p.memoryMB != null ? p.memoryMB + " MB" : "—"}</td>
      <td class="r num ${p.restarts > 5 ? "restart-warn" : ""}">${p.restarts ?? 0}</td>
      <td class="r num">${fmtUptime(p.uptime)}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="6" class="empty">No PM2 processes${s.pm2 && s.pm2.error ? " — " + esc(s.pm2.error) : ""}.</td></tr>`;

  // sidebar status indicator
  const down = svc.filter(([, st]) => st !== "up").length;
  const ok = down === 0;
  $("#pulseDot").className = "side-status-dot" + (ok ? "" : " bad");
  $("#pulseText").className = "side-status-text" + (ok ? "" : " bad");
  $("#pulseText").textContent = ok ? "All systems operational" : `${down} service${down > 1 ? "s" : ""} down`;
  $("#pulseTime").textContent = "Updated " + new Date().toLocaleTimeString();
}

// ─── markdown ─────────────────────────────────────────────────────────────────────
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
function mdInline(s) { return s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(?<![\w])\*([^*\n]+)\*(?![\w])/g, "<em>$1</em>"); }
function renderMarkdown(text) {
  const lines = esc(text).split("\n"); let html = "", inCode = false, inList = false, buf = [];
  const flushList = () => { if (inList) { html += "<ul>" + buf.join("") + "</ul>"; buf = []; inList = false; } };
  for (let raw of lines) {
    const fence = raw.match(/^```(\w*)/);
    if (fence) { if (!inCode) { flushList(); html += "<pre><code>"; inCode = true; } else { html += "</code></pre>"; inCode = false; } continue; }
    if (inCode) { html += raw + "\n"; continue; }
    if (/^\s*[-*]\s+/.test(raw)) { inList = true; buf.push("<li>" + mdInline(raw.replace(/^\s*[-*]\s+/, "")) + "</li>"); continue; }
    flushList();
    const h = raw.match(/^(#{1,3})\s+(.*)/);
    if (h) { html += `<h${h[1].length}>${mdInline(h[2])}</h${h[1].length}>`; continue; }
    if (raw.trim() === "") continue;
    html += "<p>" + mdInline(raw) + "</p>";
  }
  flushList(); if (inCode) html += "</code></pre>"; return html;
}

// ─── Mindy, the mascot ───────────────────────────────────────────────────────────
// The same daemon from the landing page, inlined so the chat has a face. One smooth
// silhouette + a glow "mind" within; bobs & blinks when idle, tilts & sparks when
// thinking. Add the `thinking` class to the wrapper to switch poses.
const MINDY_BODY = "M130 46 C178 46 206 86 206 148 C206 182 206 176 200 196 C192 201 192 210 180 210 C170 210 165 197 155 197 C145 197 142 210 130 210 C118 210 115 197 105 197 C95 197 90 210 80 210 C70 210 68 201 60 196 C54 176 54 182 54 148 C54 86 82 46 130 46 Z";
function mindySVG(size, cls) {
  return `<svg class="mindy ${cls || ""}" width="${size}" height="${Math.round(size * 280 / 260)}" viewBox="0 0 260 280" role="img" aria-label="Mindy, the ServerMind daemon">
    <defs>
      <linearGradient id="m-body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFC15A"/><stop offset="1" stop-color="#F5A524"/></linearGradient>
      <radialGradient id="m-glow" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#F5A524" stop-opacity=".55"/><stop offset="1" stop-color="#F5A524" stop-opacity="0"/></radialGradient>
      <radialGradient id="m-mind" cx="50%" cy="42%" r="55%"><stop offset="0" stop-color="#FFEFC9" stop-opacity=".85"/><stop offset="60%" stop-color="#FBBF24" stop-opacity=".32"/><stop offset="100%" stop-color="#FBBF24" stop-opacity="0"/></radialGradient>
    </defs>
    <ellipse class="m-aura" cx="130" cy="122" rx="108" ry="108" fill="url(#m-glow)"/>
    <ellipse class="m-shadow" cx="130" cy="246" rx="60" ry="11" fill="#000"/>
    <g class="m-bob">
      <path d="${MINDY_BODY}" fill="url(#m-body)" stroke="rgba(255,255,255,.10)" stroke-width="1.5"/>
      <ellipse cx="104" cy="86" rx="24" ry="15" fill="#fff" opacity=".07"/>
      <g class="m-orb"><ellipse cx="130" cy="108" rx="50" ry="52" fill="url(#m-mind)"/></g>
      <ellipse class="m-blush" cx="96" cy="150" rx="8" ry="4.5" fill="#FFD58A"/>
      <ellipse class="m-blush" cx="164" cy="150" rx="8" ry="4.5" fill="#FFD58A"/>
      <g class="m-eyes">
        <ellipse cx="108" cy="134" rx="15.5" ry="18" fill="#FFF7EA"/>
        <ellipse cx="152" cy="134" rx="15.5" ry="18" fill="#FFF7EA"/>
        <ellipse cx="108" cy="137" rx="7" ry="8" fill="#2A1D06"/>
        <ellipse cx="152" cy="137" rx="7" ry="8" fill="#2A1D06"/>
        <circle cx="104" cy="130" r="3" fill="#fff"/>
        <circle cx="148" cy="130" r="3" fill="#fff"/>
      </g>
      <path class="m-smile" d="M120 159 Q130 167 140 159" fill="none" stroke="#FFF7EA" stroke-width="3" stroke-linecap="round" opacity=".5"/>
      <g class="m-sparks">
        <circle cx="104" cy="36" r="2.6" fill="#FFEFC9"/>
        <circle cx="130" cy="24" r="3" fill="#FFEFC9"/>
        <circle cx="156" cy="38" r="2.2" fill="#FFEFC9"/>
      </g>
    </g>
  </svg>`;
}

// Friendly empty state — shown when a chat has no messages yet, so the pane never
// feels dead. Re-rendered on load, on clear, and when switching which server you chat.
function renderChatEmpty() {
  if (wrap.querySelector(".msg")) return;            // never clobber a live conversation
  const where = chatServer ? ` about <b>${esc(chatServerName)}</b>` : "";
  wrap.innerHTML = `<div class="chat-empty">
    ${mindySVG(96, "")}
    <div class="ce-title">Hi, I'm Mindy</div>
    <div class="ce-sub">Your server's daemon, given a face. Ask me anything${where} — restart a service, free up disk, or just check how things are running.</div>
  </div>`;
}

// ─── chat DOM ──────────────────────────────────────────────────────────────────────
function addMsg(role) {
  const empty = wrap.querySelector(".chat-empty"); if (empty) empty.remove();
  const m = document.createElement("div");
  m.className = "msg " + role;
  m.innerHTML = `<div class="who">${role === "user" ? "You" : "ServerMind"}</div><div class="body"></div>`;
  wrap.appendChild(m); scroll(); return m.querySelector(".body");
}
// autoscroll only when the user is already near the bottom (don't yank them up)
function scroll(force) { const l = $("#log"); if (force || l.scrollHeight - l.scrollTop - l.clientHeight < 140) l.scrollTop = l.scrollHeight; }

// "thinking" indicator shown while waiting for the model / between tools — Mindy
// tilts and sparks beside a row of pulsing dots so the wait feels alive.
function setThinking(body, on) {
  let t = body.querySelector(".thinking");
  if (on && !t) {
    t = document.createElement("div"); t.className = "thinking";
    t.innerHTML = mindySVG(30, "thinking") + `<span class="dots"><span></span><span></span><span></span></span>`;
    body.appendChild(t); scroll();
  } else if (!on && t) { t.remove(); }
}

function addToolCard(body, name, mutating) {
  const card = document.createElement("div");
  card.className = "tool" + (mutating ? " mutating" : "");
  card.innerHTML = `<div class="head"><span class="name">${esc(name)}</span>${mutating ? '<span class="badge">mutating</span>' : '<span class="badge">running…</span>'}<span class="arrow">▸</span></div><div class="detail"></div>`;
  card.querySelector(".head").onclick = () => card.classList.toggle("open");
  body.appendChild(card); scroll(); return card;
}

const SEND_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`;
const STOP_ICON = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>`;
let abortCtrl = null;
function setBusy(on) {
  busy = on;
  sendBtn.innerHTML = on ? STOP_ICON : SEND_ICON;
  sendBtn.title = on ? "Stop" : "Send";
  sendBtn.classList.toggle("stop", on);
}

input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 180) + "px"; });
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!busy) send(); } });
sendBtn.onclick = () => { if (busy) abortCtrl && abortCtrl.abort(); else send(); };
$("#clear") && ($("#clear").onclick = () => { history = []; wrap.innerHTML = ""; renderChatEmpty(); renderHint(); });

function renderHint() {
  $("#hint").innerHTML = history.length ? "" : SUGGESTIONS.map((s) => `<span>${esc(s)}</span>`).join("");
  $("#hint").querySelectorAll("span").forEach((el) => el.onclick = () => { input.value = el.textContent; input.focus(); });
}
renderHint();

async function send() {
  if (busy) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = ""; input.style.height = "auto";
  setBusy(true);
  addMsg("user").innerHTML = renderMarkdown(text);
  history.push({ role: "user", content: text });
  $("#hint").innerHTML = "";
  const body = addMsg("assistant");
  setThinking(body, true);                 // show dots immediately while the model spins up
  let textSpan = null, acc = "";
  const ensureText = () => { setThinking(body, false); if (!textSpan) { textSpan = document.createElement("div"); textSpan.className = "cursor"; body.appendChild(textSpan); } return textSpan; };
  let liveCards = {};
  abortCtrl = new AbortController();
  try {
    const res = await fetch("/chat", { method: "POST", headers: { "content-type": "application/json" }, signal: abortCtrl.signal, body: JSON.stringify({ message: text, history: history.slice(0, -1), server: chatServer || undefined }) });
    if (res.status === 401) { showGate("Session expired — sign in again."); throw new Error("unauthorized"); }
    if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const events = buf.split("\n\n"); buf = events.pop() || "";
      for (const chunk of events) handleEvent(chunk);
    }
  } catch (e) {
    setThinking(body, false);
    if (e.name === "AbortError") { const w = document.createElement("div"); w.className = "msg-note"; w.textContent = "■ stopped"; body.appendChild(w); }
    else if (e.message !== "unauthorized") { const w = document.createElement("div"); w.className = "msg-error"; w.textContent = "⚠ " + e.message; body.appendChild(w); }
  } finally {
    setThinking(body, false);
    if (textSpan) textSpan.classList.remove("cursor");
    if (acc.trim()) history.push({ role: "assistant", content: acc });
    abortCtrl = null; setBusy(false); scroll(); loadStatus();
  }
  function handleEvent(chunk) {
    let event = "message", data = "";
    for (const line of chunk.split("\n")) { if (line.startsWith("event:")) event = line.slice(6).trim(); else if (line.startsWith("data:")) data += line.slice(5).trim(); }
    if (!data) return;
    let payload; try { payload = JSON.parse(data); } catch { return; }
    if (event === "text") { acc += payload.delta; ensureText().innerHTML = renderMarkdown(acc); scroll(); }
    else if (event === "tool_use") {
      textSpan = null; setThinking(body, false);
      const card = addToolCard(body, payload.name, payload.mutating);
      card.querySelector(".detail").innerHTML = `<pre>${esc(JSON.stringify(payload.input, null, 2))}</pre>`;
      liveCards[payload.id || "__last"] = card; liveCards["__last"] = card;
    } else if (event === "tool_result") {
      const card = liveCards[payload.id] || liveCards["__last"];
      if (card) {
        if (payload.isError) card.classList.add("error");
        card.querySelector(".head .badge").textContent = payload.isError ? "error" : "done";
        const res = document.createElement("div"); res.className = "res"; res.innerHTML = `<pre>${esc(payload.preview)}</pre>`;
        card.querySelector(".detail").appendChild(res);
      }
      setThinking(body, true);             // tool done → model is thinking again
    } else if (event === "error") {
      setThinking(body, false);
      const w = document.createElement("div"); w.className = "msg-error"; w.textContent = "⚠ " + (payload.message || "error"); body.appendChild(w);
    }
  }
}

// ─── boot ──────────────────────────────────────────────────────────────────────────
showSkeletons();   // paint placeholders on first frame, before /auth/me resolves
(async function boot() {
  try {
    const r = await fetch("/auth/me"); const me = await r.json();
    if (me.authenticated) { armed = !!me.armed; renderArm(); loadStatus(); afterAuth(me); }
    else if (!me.configured) showGate("Auth not set up — run `bun run setup-auth` on the server.");
    else showGate("");
  } catch { showGate(""); }
})();
setInterval(() => {
  if ($("#gate").classList.contains("flex")) return;
  loadStatus(); // keeps the sidebar pulse + overview fresh
  if (!document.querySelector('[data-view="fleet"]').classList.contains("hidden")) loadFleet();
}, 15_000);

// ─── settings panel ──────────────────────────────────────────────────────────
const SET = {};
["EmailEnabled","EmailTo","EmailFrom","EmailMethod","DigestHour","SmtpHost","SmtpPort","SmtpUser","SmtpPass","ResendKey","DiskPct","MemPct","CertDays","CertDomains","MonitoredUnits","AiBackend","AiBaseUrl","AiModel","AiApiKey","ClaudeModel"].forEach((k) => (SET[k] = $("#set" + k)));

function setMsg(t, bad) { const m = $("#setMsg"); if (!m) return; m.textContent = t || ""; m.classList.toggle("bad", !!bad); m.classList.toggle("good", !!t && !bad); }
function setGroups() {
  $("#setSmtpGroup").classList.toggle("hidden", SET.EmailMethod.value !== "smtp");
  $("#setResendGroup").classList.toggle("hidden", SET.EmailMethod.value !== "resend");
  $("#setOpenaiGroup").classList.toggle("hidden", SET.AiBackend.value !== "openai");
  $("#setClaudeGroup").classList.toggle("hidden", SET.AiBackend.value !== "claude-code");
}
if (SET.EmailMethod) SET.EmailMethod.onchange = setGroups;
if (SET.AiBackend) SET.AiBackend.onchange = setGroups;

async function loadSettings() {
  setMsg("");
  try {
    const r = await fetch("/settings");
    if (!r.ok) return setMsg(r.status === 401 ? "Not signed in." : "Failed to load settings.", true);
    const d = await r.json();
    SET.EmailEnabled.checked = !!d.email.enabled;
    SET.EmailTo.value = d.email.to || "";
    SET.EmailFrom.value = d.email.from || "";
    SET.EmailMethod.value = d.email.method || "smtp";
    SET.DigestHour.value = d.alerts.digestHour >= 0 ? d.alerts.digestHour : "";
    SET.SmtpHost.value = d.email.smtpHost || "";
    SET.SmtpPort.value = d.email.smtpPort || "";
    SET.SmtpUser.value = d.email.smtpUser || "";
    SET.SmtpPass.value = d.email.smtpPass || "";
    SET.ResendKey.value = d.email.resendKey || "";
    SET.DiskPct.value = d.alerts.diskPct;
    SET.MemPct.value = d.alerts.memPct;
    SET.CertDays.value = d.alerts.certDays;
    SET.CertDomains.value = (d.alerts.certDomains || []).join(", ");
    SET.MonitoredUnits.value = (d.monitoredUnits || []).join(", ");
    SET.AiBackend.value = d.ai.backend || "openai";
    SET.AiBaseUrl.value = d.ai.baseUrl || "";
    SET.AiModel.value = d.ai.model || "";
    SET.AiApiKey.value = d.ai.apiKey || "";
    SET.ClaudeModel.value = d.ai.claudeModel || "";
    setGroups();
  } catch (e) { setMsg("Failed to load: " + e.message, true); }
}

function collectSettings() {
  return {
    email: {
      enabled: SET.EmailEnabled.checked, to: SET.EmailTo.value.trim(), from: SET.EmailFrom.value.trim(), method: SET.EmailMethod.value,
      smtpHost: SET.SmtpHost.value.trim(), smtpPort: SET.SmtpPort.value.trim(), smtpUser: SET.SmtpUser.value.trim(),
      smtpPass: SET.SmtpPass.value, resendKey: SET.ResendKey.value,
    },
    alerts: { diskPct: SET.DiskPct.value, memPct: SET.MemPct.value, digestHour: SET.DigestHour.value.trim(), certDays: SET.CertDays.value, certDomains: SET.CertDomains.value },
    monitoredUnits: SET.MonitoredUnits.value,
    ai: { backend: SET.AiBackend.value, baseUrl: SET.AiBaseUrl.value.trim(), model: SET.AiModel.value.trim(), apiKey: SET.AiApiKey.value, claudeModel: SET.ClaudeModel.value.trim() },
  };
}
async function saveSettings() {
  const r = await fetch("/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(collectSettings()) });
  if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || "save failed (" + r.status + ")"); }
}

if ($("#setSave")) $("#setSave").onclick = async () => {
  const b = $("#setSave"); b.disabled = true; setMsg("Saving…");
  try { await saveSettings(); await loadSettings(); setMsg("Saved ✓"); } catch (e) { setMsg(e.message, true); }
  b.disabled = false;
};
if ($("#setTestEmail")) $("#setTestEmail").onclick = async () => {
  setMsg("Saving + sending test…");
  try { await saveSettings(); const r = await fetch("/settings/test-email", { method: "POST" }); if (r.ok) setMsg("Test email sent ✓ — check your inbox (and spam the first time)."); else { const d = await r.json().catch(() => ({})); setMsg("Test failed: " + (d.error || r.status), true); } }
  catch (e) { setMsg(e.message, true); }
};
if ($("#setReportNow")) $("#setReportNow").onclick = async () => {
  setMsg("Saving + sending report…");
  try { await saveSettings(); const r = await fetch("/settings/report-now", { method: "POST" }); if (r.ok) setMsg("Report sent ✓"); else { const d = await r.json().catch(() => ({})); setMsg("Report failed: " + (d.error || r.status), true); } }
  catch (e) { setMsg(e.message, true); }
};

// ─── custom tools panel ──────────────────────────────────────────────────────
let toolsState = [];
let editingName = null;

function tfMsg(t, bad) { const m = $("#tfMsg"); if (!m) return; m.textContent = t || ""; m.classList.toggle("bad", !!bad); m.classList.toggle("good", !!t && !bad); }
function showKindFields() {
  const kind = $("#tfKind").value;
  document.querySelectorAll("#toolForm .tf-group").forEach((g) => {
    const kinds = (g.dataset.kinds || "").split(/\s+/);
    g.classList.toggle("hidden", !kinds.includes(kind));
  });
}

async function loadTools() {
  try {
    const r = await fetch("/settings/tools");
    if (!r.ok) { if (r.status === 401) showGate("Session expired — sign in again."); return; }
    const d = await r.json();
    toolsState = d.tools || [];
    renderTools();
  } catch { /* keep last render */ }
}

function renderTools() {
  const list = $("#toolList"), sum = $("#toolsSummary");
  if (sum) sum.textContent = `Your tools · ${toolsState.length}`;
  if (!list) return;
  if (!toolsState.length) { list.innerHTML = `<div class="fleet-empty">No custom tools yet. Click <b>＋ Add tool</b> to create one.</div>`; return; }
  list.innerHTML = toolsState.map(toolCard).join("");
}

function toolCard(t) {
  const detail = t.kind === "command" ? esc(t.argv.join(" "))
    : t.kind === "db_query" ? `${esc(t.engine)} · ${esc(t.query)}`
    : t.kind === "db_console" ? `${esc(t.engine)} · AI-written SELECT (read-only)`
    : t.kind === "http_check" ? esc(t.url)
    : esc(t.path);
  const tag = t.kind === "command" && t.mutating ? `<span class="ct-tag mut">mutating</span>` : `<span class="ct-tag">read-only</span>`;
  return `<div class="ct-card">
    <div class="ct-main">
      <div class="ct-name">${esc(t.name)} <span class="ct-kind">${esc(t.kind)}</span> ${tag}</div>
      <div class="ct-desc">${esc(t.description)}</div>
      <div class="ct-detail mono">${detail}</div>
    </div>
    <div class="ct-actions">
      <button class="btn ghost ct-edit" data-name="${esc(t.name)}">Edit</button>
      <button class="btn ghost ct-del" data-name="${esc(t.name)}">Delete</button>
    </div>
  </div>`;
}

function openToolForm(tool) {
  const isDb = tool && (tool.kind === "db_query" || tool.kind === "db_console");
  editingName = tool ? tool.name : null;
  $("#toolForm").classList.remove("hidden");
  $("#tfName").value = tool?.name || "";
  $("#tfName").disabled = !!tool;               // name is the key — don't rename in place
  $("#tfDesc").value = tool?.description || "";
  $("#tfKind").value = tool?.kind || "command";
  $("#tfArgv").value = tool?.kind === "command" ? tool.argv.join("\n") : "";
  $("#tfMutating").checked = tool?.kind === "command" ? !!tool.mutating : false;
  $("#tfTimeout").value = tool?.kind === "command" ? (tool.timeoutMs || "") : "";
  $("#tfEngine").value = isDb ? tool.engine : "mysql";
  $("#tfDbHost").value = isDb ? tool.conn.host : "";
  $("#tfDbPort").value = isDb ? tool.conn.port : "";
  $("#tfDbName").value = isDb ? (tool.conn.database || "") : "";
  $("#tfDbUser").value = isDb ? (tool.conn.user || "") : "";
  $("#tfDbPass").value = isDb ? (tool.conn.password || "") : ""; // masked from the server
  $("#tfQuery").value = tool?.kind === "db_query" ? tool.query : ""; // frozen query is db_query only
  $("#tfUrl").value = tool?.kind === "http_check" ? tool.url : "";
  $("#tfStatus").value = tool?.kind === "http_check" ? (tool.expectStatus || "") : "";
  $("#tfJsonPath").value = tool?.kind === "http_check" ? (tool.jsonPath || "") : "";
  $("#tfExpected").value = tool?.kind === "http_check" ? (tool.expected || "") : "";
  $("#tfPath").value = tool?.kind === "read_file" ? tool.path : "";
  $("#tfLines").value = tool?.kind === "read_file" ? (tool.lines || "") : "";
  showKindFields();
  tfMsg("");
  $("#toolForm").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function closeToolForm() { $("#toolForm").classList.add("hidden"); editingName = null; }

// Assemble a manifest from the form fields, omitting blank optionals.
function buildManifest() {
  const kind = $("#tfKind").value;
  const base = { kind, name: $("#tfName").value.trim(), description: $("#tfDesc").value.trim() };
  if (kind === "command") {
    const m = { ...base, argv: $("#tfArgv").value.split("\n").map((s) => s.trim()).filter(Boolean), mutating: $("#tfMutating").checked };
    const t = $("#tfTimeout").value.trim(); if (t) m.timeoutMs = Number(t);
    return m;
  }
  if (kind === "db_query" || kind === "db_console") {
    const conn = { host: $("#tfDbHost").value.trim(), port: Number($("#tfDbPort").value.trim() || 0), user: $("#tfDbUser").value.trim(), password: $("#tfDbPass").value };
    const db = $("#tfDbName").value.trim(); if (db) conn.database = db;
    const m = { ...base, engine: $("#tfEngine").value, conn };
    if (kind === "db_query") m.query = $("#tfQuery").value.trim();
    return m;
  }
  if (kind === "http_check") {
    const m = { ...base, url: $("#tfUrl").value.trim() };
    const s = $("#tfStatus").value.trim(); if (s) m.expectStatus = Number(s);
    const jp = $("#tfJsonPath").value.trim(); if (jp) m.jsonPath = jp;
    const ex = $("#tfExpected").value; if (ex !== "") m.expected = ex;
    return m;
  }
  const m = { ...base, path: $("#tfPath").value.trim() };
  const ln = $("#tfLines").value.trim(); if (ln) m.lines = Number(ln);
  return m;
}

async function saveTools(nextList) {
  const r = await fetch("/settings/tools", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tools: nextList }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "save failed (" + r.status + ")");
  toolsState = d.tools || [];
}

if ($("#tfKind")) $("#tfKind").onchange = showKindFields;
if ($("#addToolBtn")) $("#addToolBtn").onclick = () => openToolForm(null);
if ($("#tfCancel")) $("#tfCancel").onclick = closeToolForm;
if ($("#tfSave")) $("#tfSave").onclick = async () => {
  const b = $("#tfSave"); b.disabled = true; tfMsg("Saving…");
  try {
    const m = buildManifest();
    const others = toolsState.filter((t) => t.name !== (editingName || m.name));
    await saveTools([...others, m]);
    renderTools(); closeToolForm();
  } catch (e) { tfMsg(e.message, true); }
  b.disabled = false;
};
if ($("#tfTest")) $("#tfTest").onclick = async () => {
  tfMsg("Testing…");
  try {
    const r = await fetch("/settings/tools/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: buildManifest() }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { tfMsg(d.error || "test failed", true); return; }
    tfMsg((d.ok ? "✓ " : "✗ ") + (d.output || "(no output)").slice(0, 300), !d.ok);
  } catch (e) { tfMsg(e.message, true); }
};
if ($("#toolList")) $("#toolList").addEventListener("click", async (e) => {
  const ed = e.target.closest(".ct-edit");
  if (ed) { const t = toolsState.find((x) => x.name === ed.dataset.name); if (t) openToolForm(t); return; }
  const dl = e.target.closest(".ct-del");
  if (dl) {
    if (!confirm(`Delete tool "${dl.dataset.name}"?`)) return;
    try { await saveTools(toolsState.filter((t) => t.name !== dl.dataset.name)); renderTools(); } catch (err) { alert(err.message); }
  }
});

// ─── fleet (controller multi-server view) ────────────────────────────────────
function applyAuthState(me) {
  isController = !!(me && me.fleet);
  const nav = $("#navFleet");
  if (nav) nav.style.display = isController ? "" : "none";          // Fleet nav only on a controller
  const lbl = $("#navOverviewLabel");
  if (lbl) lbl.textContent = isController ? "This server" : "Overview"; // own box is secondary on a controller
}
// On a controller the default landing is the Fleet (all servers); a standalone
// box lands on its own Overview. An explicit #hash always wins.
function afterAuth(me) {
  applyAuthState(me);
  showView(location.hash.slice(1) ? viewFromHash() : (me && me.fleet ? "fleet" : "overview"));
}

async function loadFleet() {
  const grid = $("#fleetGrid");
  if (!grid) return;
  try {
    const r = await fetch("/fleet");
    if (!r.ok) { if (r.status === 401) showGate("Session expired — sign in again."); return; }
    const d = await r.json();
    fleetJoinToken = d.joinToken || "";
    fleetMesh = !!d.mesh;
    const addBtn = $("#addServerBtn");
    if (addBtn) addBtn.style.display = d.enabled ? "" : "none";
    if (!d.enabled) { grid.innerHTML = `<div class="fleet-empty">This instance isn't a controller. Set <code>FLEET_JOIN_TOKEN</code> and install agents to manage multiple servers from here.</div>`; return; }
    fleetCanChat = !!d.canChat;
    if (!d.servers.length) { grid.innerHTML = `<div class="fleet-empty">No servers connected yet. Click <b>＋ Add server</b> above for the one-line enroll command.</div>`; }
    else { grid.innerHTML = d.servers.map(fleetCard).join(""); }
    const online = d.servers.filter((s) => s.online).length;
    const sum = $("#fleetSummary");
    if (sum) sum.textContent = `${d.servers.length} server${d.servers.length !== 1 ? "s" : ""} · ${online} online`;
  } catch { /* keep last render */ }
}

// Fleet card actions: "Manage" → chat that server; "Remove" → drop a stale one.
$("#fleetGrid") && $("#fleetGrid").addEventListener("click", (e) => {
  const m = e.target.closest(".fc-manage");
  if (m) { selectServer(m.dataset.server, m.dataset.host, m.dataset.armed === "1"); return; }
  const rm = e.target.closest(".fc-remove");
  if (rm) { removeServer(rm.dataset.server, rm.dataset.host); }
});
async function removeServer(id, host) {
  const msg = fleetMesh
    ? `Revoke "${host}"?\nIts WireGuard peer is removed immediately — it can't reach the mesh until re-enrolled.`
    : `Remove "${host}" from the fleet?\nIt will reappear if its agent reconnects.`;
  if (!confirm(msg)) return;
  try { await fetch("/fleet/remove", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ server: id }) }); } catch {}
  loadFleet();
}

// "Add server" → reveal the one-line enroll command for a new box. The controller
// URL is whatever you used to reach this UI (agents must be able to reach it too);
// --mesh is appended when this controller runs a WireGuard mesh.
function buildEnrollCommand() {
  const origin = location.origin;                       // e.g. https://controller.example.com
  const wsHost = location.host;                          // host[:port]
  const wsScheme = location.protocol === "https:" ? "wss" : "ws";
  const meshFlag = fleetMesh ? " --mesh" : "";
  return `curl -fsSL ${origin}/install.sh | bash -s -- \\\n  --controller ${wsScheme}://${wsHost}/fleet/agent --token ${fleetJoinToken}${meshFlag}`;
}
$("#addServerBtn") && ($("#addServerBtn").onclick = () => {
  const panel = $("#addServerPanel");
  if (!panel) return;
  const showing = !panel.classList.contains("hidden");
  if (showing) { panel.classList.add("hidden"); return; }
  $("#enrollCmd").textContent = buildEnrollCommand();
  const note = $("#enrollNote");
  if (note) note.textContent = fleetMesh ? "Mesh enroll: the agent dials in, gets a WireGuard address, then talks over the tunnel." : "";
  panel.classList.remove("hidden");
});
$("#copyEnrollBtn") && ($("#copyEnrollBtn").onclick = async () => {
  try { await navigator.clipboard.writeText(buildEnrollCommand()); const b = $("#copyEnrollBtn"); const t = b.textContent; b.textContent = "Copied ✓"; setTimeout(() => (b.textContent = t), 1500); } catch {}
});
function selectServer(id, host, isArmed) {
  chatServer = id; chatServerName = host;
  armed = !!isArmed; renderArm();
  renderChatContext();
  history = []; wrap.innerHTML = "";
  showView("assistant");
}
function clearServer() {
  chatServer = null; chatServerName = "";
  history = []; wrap.innerHTML = ""; renderChatEmpty();
  renderChatContext();
  fetch("/auth/me").then((r) => r.json()).then((me) => { armed = !!me.armed; renderArm(); }).catch(() => {});
}
function renderChatContext() {
  const el = $("#chatContext");
  if (!el) return;
  if (chatServer) {
    el.style.display = "";
    el.innerHTML = `<span class="cc-dot"></span>Managing <b>${esc(chatServerName)}</b><button class="cc-clear" id="ccClear" title="Back to this server">✕</button>`;
    $("#ccClear").onclick = clearServer;
  } else { el.style.display = "none"; el.innerHTML = ""; }
}

function fleetCard(s) {
  const m = s.status && s.status.metrics;
  const cpu = m ? (m.cpu.load1 ?? 0).toFixed(2) : "—";
  const cpuPct = m && m.cpu.cores ? Math.round((m.cpu.load1 / m.cpu.cores) * 100) : 0;
  const memPct = m ? m.memory.usedPct : null;
  const diskPct = m ? m.disk.usedPct : null;
  const svc = s.status && s.status.services ? Object.values(s.status.services) : [];
  const up = svc.filter((v) => v === "active").length;
  const st = s.status || {};
  const badges = [];
  if (st.redis && typeof st.redis.connected === "boolean") badges.push(`<span class="fc-badge ${st.redis.connected ? "ok" : "down"}">redis</span>`);
  if (st.mysql) badges.push(`<span class="fc-badge ${st.mysql.ok ? "ok" : "down"}">mysql</span>`);
  if (st.pm2) { const n = Array.isArray(st.pm2.processes) ? st.pm2.processes.length : null; badges.push(`<span class="fc-badge ${st.pm2.ok ? "ok" : "down"}">pm2${n != null ? " " + n : ""}</span>`); }
  return `<div class="fleet-card${s.online ? "" : " off"}">
    <div class="fc-head">
      <span class="fc-dot ${s.online ? "ok" : "down"}"></span>
      <span class="fc-name">${esc(s.hostname)}</span>
      <span class="fc-state">${s.online ? "online" : "offline"}</span>
    </div>
    <div class="fc-metrics">
      <div class="fc-m"><span class="fc-k">CPU</span><span class="fc-v ${m ? tone(cpuPct) : ""}">${cpu}</span></div>
      <div class="fc-m"><span class="fc-k">Mem</span><span class="fc-v ${memPct != null ? tone(memPct) : ""}">${memPct != null ? memPct + "%" : "—"}</span></div>
      <div class="fc-m"><span class="fc-k">Disk</span><span class="fc-v ${diskPct != null ? tone(diskPct) : ""}">${diskPct != null ? diskPct + "%" : "—"}</span></div>
    </div>
    ${badges.length ? `<div class="fc-svcs">${badges.join("")}</div>` : ""}
    <div class="fc-foot">
      <span>${svc.length ? `${up}/${svc.length} up` : (m ? "no units" : "waiting…")}</span>
      ${s.online
        ? (fleetCanChat ? `<button class="fc-manage" data-server="${esc(s.id)}" data-host="${esc(s.hostname)}" data-armed="${s.armed ? 1 : 0}">Manage →</button>` : "")
        : `<button class="fc-remove" data-server="${esc(s.id)}" data-host="${esc(s.hostname)}">Remove</button>`}
    </div>
  </div>`;
}
