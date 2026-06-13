const $ = (s) => document.querySelector(s);
const wrap = $("#wrap"), input = $("#input"), sendBtn = $("#send");
let history = [];
let busy = false;
let armed = false;
let lastStatus = null;
const cpuHist = [], memHist = [];   // rolling samples for sparklines

// ─── view switching + mobile drawer ─────────────────────────────────────────────
function showView(name) {
  document.querySelectorAll("[data-view]").forEach((v) => {
    const on = v.dataset.view === name;
    v.classList.toggle("hidden", !on);
    v.classList.toggle("flex", on && name === "assistant");
  });
  document.querySelectorAll("[data-nav]").forEach((n) => n.classList.toggle("active", n.dataset.nav === name));
  $("#pageTitle").textContent = name === "assistant" ? "Assistant" : "Overview";
  if (name === "assistant") setTimeout(() => input.focus(), 30);
  closeDrawer();
}
document.querySelectorAll("[data-nav]").forEach((n) => n.onclick = () => showView(n.dataset.nav));
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
    if (r.ok) { $("#password").value = ""; $("#totp").value = ""; hideGate(); loadStatus(); return; }
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
function spark(vals, w = 120, h = 32) {
  if (vals.length < 2) return `<svg width="${w}" height="${h}"></svg>`;
  const max = Math.max(...vals), min = Math.min(...vals), rng = (max - min) || 1, step = w / (vals.length - 1);
  const pts = vals.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - ((v - min) / rng) * (h - 4)).toFixed(1)}`).join(" ");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function kpiCard(opts) {
  return `<div class="metric-card" data-tone="${opts.tone || "accent"}">
    <div class="metric-head">
      <span class="metric-label">${opts.label}</span>
      ${opts.sparkVals ? `<span class="metric-spark">${spark(opts.sparkVals)}</span>` : `<span class="metric-icon">${opts.icon || ""}</span>`}
    </div>
    <div class="metric-value mono">${opts.value}</div>
    <div class="metric-sub mono">${opts.sub || ""}</div>
    ${opts.pct != null ? `<div class="metric-bar"><span class="metric-bar-fill" style="width:${Math.min(opts.pct, 100)}%"></span></div>` : ""}
  </div>`;
}

// ─── skeleton loading ────────────────────────────────────────────────────────────
function showSkeletons() {
  if (lastStatus) return;   // only before the first real payload — never flicker on refresh
  $("#kpis").innerHTML = Array.from({ length: 4 }, () => `
    <div class="metric-card skeleton-card">
      <div class="metric-head"><span class="sk sk-label"></span><span class="sk sk-spark"></span></div>
      <span class="sk sk-value"></span>
      <span class="sk sk-sub"></span>
      <span class="sk sk-bar"></span>
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

  // KPI cards
  const cards = [];
  if (m.cpu) {
    cards.push(kpiCard({ label: "CPU Load", value: (m.cpu.load1 ?? 0).toFixed(2), sub: `${m.cpu.cores} cores · ${cpuPct ?? 0}%`, pct: cpuPct, tone: tone(cpuPct ?? 0), sparkVals: cpuHist.slice() }));
  }
  if (m.memory) {
    cards.push(kpiCard({ label: "Memory", value: m.memory.usedPct + "%", sub: `${fmtBytes(m.memory.usedBytes)} / ${fmtBytes(m.memory.totalBytes)}`, pct: m.memory.usedPct, tone: tone(m.memory.usedPct), sparkVals: memHist.slice() }));
  }
  if (m.disk) {
    cards.push(kpiCard({ label: "Disk (" + (m.disk.mount || "/") + ")", value: m.disk.usedPct + "%", sub: `${fmtBytes(m.disk.usedBytes)} / ${fmtBytes(m.disk.sizeBytes)}`, pct: m.disk.usedPct, tone: tone(m.disk.usedPct), icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/></svg>` }));
  }
  cards.push(kpiCard({ label: "Uptime", value: (host.uptime || "—").replace(/^up\s*/, ""), sub: host.hostname || "", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/></svg>` }));
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
    if (me.authenticated) { armed = !!me.armed; renderArm(); loadStatus(); }
    else if (!me.configured) showGate("Auth not set up — run `bun run setup-auth` on the server.");
    else showGate("");
  } catch { showGate(""); }
})();
setInterval(() => { if (!$("#gate").classList.contains("flex")) loadStatus(); }, 15_000);
