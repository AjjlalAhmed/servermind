/* ServerMind landing — award-layer motion.
   Everything here is progressive enhancement: if it doesn't run, the page is fine. */
(function () {
  const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const lerp  = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fine  = matchMedia("(hover: hover) and (pointer: fine)").matches;

  /* GSAP motion layer engaged → it owns the hero parallax, the magnetic/tilt
     hover effects and the How-it-works step activation, so those stand down
     here. The scroll-progress bar, auto-hiding nav and the big statement
     word-rise are GSAP-agnostic and keep running. */
  const GSAP = document.documentElement.classList.contains("sm-gsap");

  /* The page renders straight away (no boot curtain). Still fire sm:booted so the
     GSAP hero entrance gets its cue immediately. */
  document.dispatchEvent(new Event("sm:booted"));

  /* ─── scroll progress + auto-hiding nav ─── */
  const prog = $("#sprog"), nav = $(".nav");
  let lastY = scrollY;
  function onScroll() {
    const h = document.documentElement, max = h.scrollHeight - h.clientHeight;
    if (prog) prog.style.width = (max > 0 ? clamp(scrollY / max, 0, 1) * 100 : 0) + "%";
    if (nav) nav.classList.toggle("hide", scrollY > lastY && scrollY > 260);
    lastY = scrollY;
  }
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ─── big statement: split into words, rise them in on view ─── */
  (function () {
    const el = $("#statement");
    if (!el) return;
    if (RM || !window.IntersectionObserver) return; // plain text is the fallback
    let wi = 0;
    function wrapText(node) {
      const frag = document.createDocumentFragment();
      node.textContent.split(/(\s+)/).forEach((tok) => {
        if (tok.trim() === "") { frag.appendChild(document.createTextNode(tok)); return; }
        const w = document.createElement("span"); w.className = "w";
        const inner = document.createElement("span");
        inner.textContent = tok; inner.style.setProperty("--wi", wi++);
        w.appendChild(inner); frag.appendChild(w);
      });
      node.replaceWith(frag);
    }
    function walk(parent) {
      [...parent.childNodes].forEach((n) => {
        if (n.nodeType === 3) wrapText(n);
        else if (n.nodeType === 1 && n.tagName !== "BR") walk(n);
      });
    }
    walk(el);
    const io = new IntersectionObserver((es) => {
      es.forEach((e) => { if (e.isIntersecting) { el.classList.add("lit"); io.disconnect(); } });
    }, { threshold: 0.35 });
    io.observe(el);
  })();

  /* ─── parallax depth on scroll (skip under GSAP — it scales these elements) ─── */
  if (!RM && !GSAP) {
    const glow = $(".hero .glow"), win = $(".preview .window"), stage = $(".hm-stage");
    let ticking = false;
    function par() {
      ticking = false;
      const y = scrollY;
      if (glow)  glow.style.transform  = `translateX(-50%) translateY(${y * 0.12}px)`;
      if (win)   win.style.transform   = `translateY(${y * -0.04}px)`;
      if (stage) stage.style.transform = `translateY(${y * -0.06}px)`;
    }
    addEventListener("scroll", () => { if (!ticking) { requestAnimationFrame(par); ticking = true; } }, { passive: true });
    par();
  }

  /* ─── magnetic buttons + card tilt (GSAP owns hover micro-interactions) ─── */
  if (!RM && !GSAP && matchMedia("(hover: hover)").matches) {
    $$(".btn-primary, .copy-btn, .hm-send").forEach((b) => {
      b.addEventListener("pointermove", (e) => {
        const r = b.getBoundingClientRect();
        const mx = e.clientX - (r.left + r.width / 2), my = e.clientY - (r.top + r.height / 2);
        b.style.transform = `translate(${mx * 0.25}px, ${my * 0.4}px)`;
      });
      b.addEventListener("pointerleave", () => { b.style.transform = ""; });
    });

    /* subtle 3D tilt on feature cards (spotlight is handled in script.js) */
    $$(".card").forEach((c) => {
      c.addEventListener("pointermove", (e) => {
        const r = c.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5, py = (e.clientY - r.top) / r.height - 0.5;
        c.style.transform = `perspective(720px) rotateX(${-py * 4}deg) rotateY(${px * 5}deg) translateY(-3px)`;
      });
      c.addEventListener("pointerleave", () => { c.style.transform = ""; });
    });
  }

  /* ─── signature: activate How-it-works steps + fill the rail on scroll ─── */
  (function () {
    if (GSAP) return; // GSAP pins the section and activates steps as you scrub
    const steps = $$(".how-step"), fill = $("#howFill");
    if (!steps.length || !window.IntersectionObserver) { steps.forEach((s) => s.classList.add("active")); return; }
    function update(cur) {
      steps.forEach((s, k) => s.classList.toggle("active", k <= cur));
      if (fill) fill.style.height = ((cur + 1) / steps.length) * 100 + "%";
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => { if (en.isIntersecting) update(steps.indexOf(en.target)); });
    }, { rootMargin: "-45% 0px -45% 0px", threshold: 0 });
    steps.forEach((s) => io.observe(s));
  })();
})();
