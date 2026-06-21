const RM = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* When the GSAP motion layer is engaged (html.sm-gsap), it owns the nav scroll
   state, the scroll reveals, the dashboard count-up and the FAQ accordion — so
   those blocks stand down here to avoid double-firing. Everything else (copy
   button, the typed story, Mindy, docs scrollspy) is GSAP-agnostic and stays. */
const GSAP = document.documentElement.classList.contains("sm-gsap");

/* ─── copy install command ─── */
$$(".copy-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy || "");
      btn.classList.add("copied");
      setTimeout(() => btn.classList.remove("copied"), 1600);
    } catch {}
  });
});

/* ─── nav scroll state (GSAP owns .scrolled when engaged) ─── */
if (!GSAP) {
  const nav = $(".nav");
  const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

/* ─── staggered reveal (GSAP ScrollTrigger owns reveals when engaged) ─── */
if (!GSAP) {
  const groups = new Map();
  $$(".reveal").forEach((el) => {
    const p = el.parentElement;
    const i = groups.get(p) || 0;
    el.style.setProperty("--d", Math.min(i, 6) * 70 + "ms");
    groups.set(p, i + 1);
  });
  if (window.IntersectionObserver) {
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }),
      { rootMargin: "0px 0px -8% 0px", threshold: 0.04 },
    );
    $$(".reveal").forEach((el) => io.observe(el));
  } else {
    $$(".reveal").forEach((el) => el.classList.add("in"));
  }
}

/* ─── count-up metrics + bar fill (GSAP owns this when engaged) ─── */
function countUp(el) {
  const target = parseFloat(el.dataset.count), dec = +(el.dataset.dec || 0), suf = el.dataset.suffix || "";
  if (RM) { el.textContent = target.toFixed(dec) + suf; return; }
  const dur = 1100, t0 = performance.now();
  (function tick(now) {
    const p = Math.min((now - t0) / dur, 1), e = 1 - Math.pow(1 - p, 3);
    el.textContent = (target * e).toFixed(dec) + suf;
    if (p < 1) requestAnimationFrame(tick);
  })(performance.now());
}
const preview = $(".window");
if (!GSAP && preview && window.IntersectionObserver) {
  const po = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      $$(".mk-val[data-count]", preview).forEach(countUp);
      $$(".mk-bar i", preview).forEach((i) => { i.style.width = (i.dataset.w || 0) + "%"; });
      po.disconnect();
    });
  }, { threshold: 0.3 });
  po.observe(preview);
}

/* ─── hero preview tabs: Fleet ⇄ this server (sidebar nav drives it) ─── */
(() => {
  const tabs = $$(".mini-nav [data-tab]");
  if (!tabs.length) return;
  const panels = $$(".mini-main .mini-panel");
  const statusText = $(".mini-status-text");
  const STATUS = { fleet: "4 servers · 3 online", overview: "All systems operational" };
  const select = (name) => {
    tabs.forEach((t) => t.classList.toggle("on", t.dataset.tab === name));
    panels.forEach((p) => { p.hidden = p.dataset.panel !== name; });
    if (statusText && STATUS[name]) statusText.textContent = STATUS[name];
  };
  tabs.forEach((t) => {
    t.addEventListener("click", () => select(t.dataset.tab));
    t.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(t.dataset.tab); }
    });
  });
})();

/* ─── mouse-follow spotlight on feature cards ─── */
if (!RM) {
  $$(".card").forEach((card) => {
    card.addEventListener("pointermove", (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", ((e.clientX - r.left) / r.width) * 100 + "%");
      card.style.setProperty("--my", ((e.clientY - r.top) / r.height) * 100 + "%");
    });
  });
}

/* ─── story: typed incident conversation ─── */
const ANSWER_PLAIN =
  "Found it — api-prod is OOM-killed. It restarted 14x in 2 minutes; memory hit the 300 MB cap. Last log line: JavaScript heap out of memory. Raise max_memory_restart, or fix the leak in the upload handler.";
const ANSWER_HTML =
  "<b>Found it — api-prod is OOM-killed.</b> It restarted 14× in 2 minutes; memory hit the 300&nbsp;MB cap. Last log line: <code>JavaScript heap out of memory</code>. Raise <code>max_memory_restart</code>, or fix the leak in the upload handler.";

function el(cls, html) { const d = document.createElement("div"); d.className = cls; if (html != null) d.innerHTML = html; return d; }

async function runStory(box) {
  if (RM) {
    box.append(
      el("sc-you", "api-prod is throwing 502s — what's wrong?"),
      el("sc-eyebrow", "ServerMind"),
      el("sc-tools", `<span class="sc-tool"><b>pm2_action</b><span class="done">done</span></span><span class="sc-tool"><b>read_log</b><span class="done">done</span></span>`),
      el("sc-ai", ANSWER_HTML),
    );
    return;
  }
  box.append(el("sc-you", "api-prod is throwing 502s — what's wrong?"));
  await sleep(650);
  box.append(el("sc-eyebrow", "ServerMind"));
  const think = el("sc-think", "<i></i><i></i><i></i>");
  box.append(think); await sleep(950); think.remove();
  const tools = el("sc-tools", ""); box.append(tools);
  for (const t of ["pm2_action", "read_log"]) {
    const chip = el("sc-tool", `<b>${t}</b><span class="done" style="opacity:0">done</span>`);
    tools.append(chip); await sleep(520);
    chip.querySelector(".done").style.opacity = "1";
  }
  await sleep(300);
  const ai = el("sc-ai caret", ""); box.append(ai);
  for (let i = 0; i < ANSWER_PLAIN.length; i++) {
    ai.textContent = ANSWER_PLAIN.slice(0, i + 1);
    await sleep(ANSWER_PLAIN[i] === " " ? 14 : 18);
  }
  ai.classList.remove("caret");
  ai.innerHTML = ANSWER_HTML;
}

const story = $("#storyChat");
if (story && window.IntersectionObserver) {
  const so = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) { runStory(story); so.disconnect(); } });
  }, { threshold: 0.4 });
  so.observe(story);
} else if (story) {
  runStory(story);
}

/* ─── FAQ: single-open accordion (GSAP owns the animated accordion when engaged) ─── */
if (!GSAP) {
  const faqItems = $$(".faq-item");
  faqItems.forEach((item) => {
    item.addEventListener("toggle", () => {
      if (!item.open) return;
      faqItems.forEach((other) => { if (other !== item) other.open = false; });
    });
  });
}

/* ─── Docs: scrollspy that lights the active TOC link ─── */
(function () {
  const toc = $(".doc-toc");
  if (!toc || !window.IntersectionObserver) return;
  const links = $$("a", toc);
  const byId = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
  const sections = $$(".prose > section[id]");
  const spy = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        links.forEach((a) => a.classList.remove("active"));
        byId.get(e.target.id)?.classList.add("active");
      });
    },
    { rootMargin: "-80px 0px -70% 0px", threshold: 0 },
  );
  sections.forEach((s) => spy.observe(s));
})();

/* ─── hero: Mindy watches the cursor and answers ─── */
(function () {
  const mindy = $("#heroMindy");
  if (!mindy) return;
  const pupils = $("#heroPupils"), bar = $("#hmBar"), cmd = $("#hmCmd"), reply = $("#hmReply");

  // eyes follow the pointer, eased
  let tx = 0, ty = 0, cx = 0, cy = 0;
  addEventListener("pointermove", (e) => {
    const r = mindy.getBoundingClientRect();
    const ex = r.left + r.width * 0.5, ey = r.top + r.height * 0.47;
    const dx = e.clientX - ex, dy = e.clientY - ey, d = Math.hypot(dx, dy) || 1, max = 3.4;
    tx = (dx / d) * Math.min(max, d / 40);
    ty = (dy / d) * Math.min(max, d / 40);
  }, { passive: true });
  (function loop() {
    cx += (tx - cx) * 0.18; cy += (ty - cy) * 0.18;
    pupils.setAttribute("transform", `translate(${cx.toFixed(2)},${cy.toFixed(2)})`);
    requestAnimationFrame(loop);
  })();

  // the talk-to-it demo — real questions, real-shaped answers
  const demos = [
    ["restart pm2 api",   '<span class="ok">✓</span> api restarted · 0s downtime'],
    ["why is redis slow?", '<span class="ok">✓</span> evicting keys — maxmemory at 94%, raised to 1&nbsp;GB'],
    ["free up disk",       '<span class="ok">✓</span> cleared 2.3&nbsp;GB of logs &amp; apt cache'],
    ["is mysql healthy?",  '<span class="ok">✓</span> up 14d · 38 conns · slow-query log clean'],
  ];
  const think = (on) => mindy.classList.toggle("is-thinking", on);
  function type(t, done) {
    cmd.value = ""; let i = 0;
    (function step() {
      if (i <= t.length) { cmd.value = t.slice(0, i++); setTimeout(step, 40); }
      else done();
    })();
  }
  function run(t, a) {
    reply.classList.remove("show");
    type(t, () => {
      think(true);
      setTimeout(() => { think(false); reply.innerHTML = a; reply.classList.add("show"); }, 1150);
    });
  }

  let auto = !RM, idx = 0, timer;
  const stop = () => { auto = false; clearTimeout(timer); };
  function tick() { if (!auto) return; const d = demos[idx++ % demos.length]; run(d[0], d[1]); timer = setTimeout(tick, 4200); }
  bar.addEventListener("submit", (e) => {
    e.preventDefault(); stop();
    const t = cmd.value.trim(); if (!t) return;
    const hit = demos.find((d) => d[0] === t);
    run(t, hit ? hit[1] : '<span class="ok">✓</span> on it — ' + t);
  });
  cmd.addEventListener("focus", stop);
  if (auto) setTimeout(tick, 1100);
})();

/* Desktop downloads: make the visitor's OS the single gold (primary) button,
   quiet the other to a ghost, and float it first. One clear download. */
(function () {
  var row = document.getElementById('downloads');
  if (!row) return;
  var ua = (navigator.userAgent || '').toLowerCase();
  var plat = (navigator.platform || '').toLowerCase();
  var os = null;
  if (plat.indexOf('mac') > -1 || ua.indexOf('mac') > -1) os = 'mac';
  else if (plat.indexOf('win') > -1 || ua.indexOf('win') > -1) os = 'win';
  if (!os) return;
  var mine = row.querySelector('.dl[data-os="' + os + '"]');
  var other = row.querySelector('.dl:not([data-os="' + os + '"])');
  if (mine) {
    mine.classList.add('btn-primary'); mine.classList.remove('btn-ghost');
    row.insertBefore(mine, row.firstChild);
  }
  if (other) { other.classList.add('btn-ghost'); other.classList.remove('btn-primary'); }
})();

/* Live GitHub star count — fills [data-gh-count] and reveals [data-gh-reveal]
   on success only. Caches ~6h to stay under the unauthenticated rate limit.
   On any failure it does nothing, so the static fallbacks (nav reads
   "Star on GitHub" with no number; the hero star chip stays hidden) remain. */
(function () {
  var counts = document.querySelectorAll('[data-gh-count]');
  if (!counts.length) return;
  var KEY = 'sm_gh_stars';
  var TTL = 6 * 60 * 60 * 1000;
  var MIN = 25; // don't surface a star count until it signals real traction
                // (below this it stays hidden — the honest fallback, never faked)

  function fmt(n) {
    try { return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n); }
    catch (e) { return String(n); }
  }
  function paint(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < MIN) return;
    counts.forEach(function (el) { el.textContent = fmt(n); });
    document.querySelectorAll('[data-gh-reveal]').forEach(function (el) { el.removeAttribute('hidden'); });
  }

  try {
    var cached = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (cached && (Date.now() - cached.ts) < TTL && typeof cached.n === 'number') {
      paint(cached.n);
      return; // fresh enough — skip the network
    }
  } catch (e) { /* ignore bad cache */ }

  fetch('https://api.github.com/repos/AjjlalAhmed/servermind', { headers: { Accept: 'application/vnd.github+json' } })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function (d) {
      var n = d && d.stargazers_count;
      if (typeof n !== 'number') return;
      paint(n);
      try { localStorage.setItem(KEY, JSON.stringify({ n: n, ts: Date.now() })); } catch (e) { /* ignore */ }
    })
    .catch(function () { /* offline / rate-limited — keep the static fallback */ });
})();
