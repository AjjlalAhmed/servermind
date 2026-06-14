const $ = (s) => document.querySelector(s);
const wrap = $("#wrap"), input = $("#input"), sendBtn = $("#send");
let history = [];
let busy = false;
let armed = false;
let lastStatus = null;
const cpuHist = [], memHist = [];   // rolling samples for sparklines

// ─── view switching + URL (hash) routing + mobile drawer ─────────────────────────
const VIEWS = ["overview", "assistant", "settings"];
const viewFromHash = () => { const h = location.hash.slice(1); return VIEWS.includes(h) ? h : "overview"; };
function showView(name) {
  if (!VIEWS.includes(name)) name = "overview";
  document.querySelectorAll("[data-view]").forEach((v) => {
    const on = v.dataset.view === name;
    v.classList.toggle("hidden", !on);
    v.classList.toggle("flex", on && name === "assistant");
  });
  document.querySelectorAll("[data-nav]").forEach((n) => n.classList.toggle("active", n.dataset.nav === name));
  $("#pageTitle").textContent = name === "assistant" ? "Assistant" : name === "settings" ? "Settings" : "Overview";
  if (location.hash.slice(1) !== name) location.hash = name; // each view has its own URL: bookmarkable, back/forward works
  if (name === "assistant") setTimeout(() => input.focus(), 30);
  if (name === "settings") loadSettings();
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
  try { const r = await fetch("/auth/arm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: want }) }); if (r.ok) { const d = await r.json(); armed = !!d.armed; } } catch {}
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
    if (r.ok) { $("#password").value = ""; $("#totp").value = ""; hideGate(); loadStatus(); showView(viewFromHash()); return; }
    const data = await r.json().catch(() => ({}));
    if (r.status === 503) return showGate("Auth not set up — run `bun run setup-auth` on the server.");
    if (r.status === 429) return showGate(`Locked out — try again in ${data.retryAfterSec || 60}s.`);
    showGate(data.error || "Invalid credentials.");
  } catch (e) { showGate("Connection failed: " + e.message); }
}
$("#logout").onclick = async () => { try { await fetch("/auth/logout", { method: "POST" }); } catch {} history = []; wrap.innerHTML = ""; showGate(""); };

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
  $("#hostName").textContent = host.hostname || "—";

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
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
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

// ─── chat DOM ──────────────────────────────────────────────────────────────────────
function addMsg(role) {
  const m = document.createElement("div");
  m.className = "msg " + role;
  m.innerHTML = `<div class="who">${role === "user" ? "You" : "ServerMind"}</div><div class="body"></div>`;
  wrap.appendChild(m); scroll(); return m.querySelector(".body");
}
// autoscroll only when the user is already near the bottom (don't yank them up)
function scroll(force) { const l = $("#log"); if (force || l.scrollHeight - l.scrollTop - l.clientHeight < 140) l.scrollTop = l.scrollHeight; }

// animated "thinking" dots shown while waiting for the model / between tools
function setThinking(body, on) {
  let t = body.querySelector(".thinking");
  if (on && !t) { t = document.createElement("div"); t.className = "thinking"; t.innerHTML = "<span></span><span></span><span></span>"; body.appendChild(t); scroll(); }
  else if (!on && t) { t.remove(); }
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
$("#clear") && ($("#clear").onclick = () => { history = []; wrap.innerHTML = ""; renderHint(); });

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
    const res = await fetch("/chat", { method: "POST", headers: { "content-type": "application/json" }, signal: abortCtrl.signal, body: JSON.stringify({ message: text, history: history.slice(0, -1), allowMutations: armed }) });
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
    if (me.authenticated) { armed = !!me.armed; renderArm(); loadStatus(); showView(viewFromHash()); }
    else if (!me.configured) showGate("Auth not set up — run `bun run setup-auth` on the server.");
    else showGate("");
  } catch { showGate(""); }
})();
setInterval(() => { if (!$("#gate").classList.contains("flex")) loadStatus(); }, 15_000);

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
