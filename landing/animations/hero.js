/* ══════════════════════════════════════════════════════════════════════════
   animations/hero.js — page-load + hero/dashboard intro
   ----------------------------------------------------------------------------
   Owns everything that plays "above the fold" on first paint:
     • Nav bar drops in (target: .nav, then its links + CTA buttons stagger)
     • Hero copy reveals: h1 → subtitle → install block → note (target:
       .hero-copy children, all carrying .reveal)
     • Mindy chat panel + the live dashboard window scale up from 0.97
     • The curl install command "types" itself with a blinking caret
     • Dashboard stats count up, bars fill via scaleX, PM2 rows slide in, and
       the status dot pulses (target: the .preview .window mockup)

   It waits for award.js's boot-curtain to lift (sm:booted) so the user actually
   sees the entrance, and renders final states immediately under reduced-motion.
   ══════════════════════════════════════════════════════════════════════════ */

// Run cb once the boot intro curtain has lifted (or immediately if there isn't one).
function afterBoot(cb) {
  const boot = document.getElementById("boot");
  if (!boot || !document.body.classList.contains("booting")) {
    cb();
    return;
  }
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    cb();
  };
  document.addEventListener("sm:booted", go, { once: true });
  setTimeout(go, 4700); // safety: the curtain self-lifts by ~4.6s
}

/* The curl command types itself, terminal-style, with a forever-blinking caret.
   Targets the HERO install pill only (#install .install-cmd). Copy still works —
   the button reads data-copy, never the DOM text. */
function typeInstall(gsap) {
  const cmd = document.querySelector("#install .install-cmd");
  if (!cmd) return;
  const prompt = cmd.querySelector(".prompt");

  let full = "";
  cmd.childNodes.forEach((n) => {
    if (n !== prompt) full += n.textContent;
  });
  full = full.replace(/\s+$/, "");
  if (!full) return;

  [...cmd.childNodes].forEach((n) => {
    if (n !== prompt) n.remove();
  });
  const typed = document.createElement("span");
  typed.className = "type-text";
  const caret = document.createElement("span");
  caret.className = "type-caret";
  caret.textContent = "▍";
  cmd.append(typed, caret);

  const state = { i: 0 };
  gsap.to(state, {
    i: full.length,
    duration: Math.min(full.length * 0.022, 1.6),
    ease: "none",
    onUpdate() {
      typed.textContent = full.slice(0, Math.round(state.i));
    },
  });
  gsap.to(caret, { autoAlpha: 0, duration: 0.5, repeat: -1, yoyo: true, ease: "power1.inOut" });
}

/* Dashboard mockup (.preview .window): numbers count up, bars fill, rows slide,
   dot pulses. Fired once when the window scrolls into view. */
function dashboard(ctx) {
  const { gsap, ScrollTrigger, reduced } = ctx;
  const win = document.querySelector(".preview .window");
  if (!win) return;

  const vals = gsap.utils.toArray(".mk-val[data-count]", win);
  const bars = gsap.utils.toArray(".mk-bar i", win);
  const rows = gsap.utils.toArray(".mini-procs .mp-row", win);
  const dot = win.querySelector(".mini-dot");

  // Bars are width-based in the DOM; we drive them with scaleX (a transform) to
  // honour the perf rule. Lock in the final width first, then grow from 0.
  bars.forEach((i) => (i.style.width = (i.dataset.w || 0) + "%"));

  const setFinal = () => {
    vals.forEach((el) => {
      const dec = +(el.dataset.dec || 0);
      el.textContent = parseFloat(el.dataset.count).toFixed(dec) + (el.dataset.suffix || "");
    });
    gsap.set(bars, { scaleX: 1 });
    gsap.set(rows, { autoAlpha: 1, x: 0 });
  };

  if (reduced) {
    setFinal();
    return;
  }

  const play = () => {
    vals.forEach((el) => {
      const target = parseFloat(el.dataset.count);
      const dec = +(el.dataset.dec || 0);
      const suf = el.dataset.suffix || "";
      const o = { v: 0 };
      gsap.to(o, {
        v: target,
        duration: 1.1,
        ease: "power2.out",
        snap: dec ? undefined : { v: 1 }, // integers snap; CPU (2dp) flows
        onUpdate() {
          el.textContent = o.v.toFixed(dec) + suf;
        },
      });
    });
    gsap.from(bars, { scaleX: 0, duration: 0.9, ease: "power2.out", stagger: 0.08 });
    gsap.from(rows, { x: -22, autoAlpha: 0, duration: 0.5, stagger: 0.1, delay: 0.15, ease: "power3.out" });
    if (dot) {
      gsap.to(dot, {
        scale: 1.3,
        transformOrigin: "center",
        repeat: -1,
        yoyo: true,
        duration: 0.8,
        ease: "sine.inOut",
      });
    }
  };

  ScrollTrigger.create({ trigger: win, start: "top 85%", once: true, onEnter: play });
}

export function initHero(ctx) {
  const { gsap, reduced } = ctx;

  const navLinks = gsap.utils.toArray(".nav-links a");
  const navCta = gsap.utils.toArray(".nav-cta .btn");
  const heroReveals = gsap.utils.toArray(".hero .reveal");
  // Mark hero reveals "in" so the legacy headline underline-draw / clip wipe
  // (CSS keyed off .reveal.in) plays alongside the GSAP entrance.
  heroReveals.forEach((el) => el.classList.add("in"));

  const h1 = document.querySelector(".hero-copy h1");
  const lede = document.querySelector(".hero-copy .lede");
  const install = document.querySelector("#install");
  const note = document.querySelector(".hero-copy .install-note");
  const mindy = document.querySelector(".hero-mindy");
  const previewWin = document.querySelector(".preview");

  // Reduced motion: show everything, no movement, no typing.
  if (reduced) {
    gsap.set([".nav", ...navLinks, ...navCta, ...heroReveals], { clearProps: "all", autoAlpha: 1 });
    dashboard(ctx);
    return;
  }

  // Keep the hero hidden until the curtain lifts to avoid a flash of the
  // mid-entrance state (CSS already holds .reveal at opacity 0).
  gsap.set([h1, lede, install, note, mindy, previewWin].filter(Boolean), { autoAlpha: 0 });

  afterBoot(() => {
    const tl = gsap.timeline({ defaults: { ease: "power3.out" } });

    // Nav drops down first, then its links + buttons stagger in last.
    // clearProps:transform releases the nav so award.js's auto-hide (which uses
    // a CSS transform) isn't pinned by a leftover inline translate.
    tl.from(".nav", { y: -20, autoAlpha: 0, duration: 0.4, clearProps: "transform" })
      .from([...navLinks, ...navCta], { y: -8, autoAlpha: 0, duration: 0.3, stagger: 0.05, clearProps: "transform" }, "-=0.1");

    // Headline → subtitle → install → note, each leading the next by ~0.15s.
    tl.fromTo(h1, { y: 30, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.7 }, 0.1)
      .fromTo(lede, { y: 20, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.6 }, "-=0.45")
      .fromTo(install, { y: 20, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.6 }, "-=0.45")
      .fromTo(note, { y: 14, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.5 }, "-=0.4");

    // Chat panel + dashboard window fade in and scale up slightly.
    tl.fromTo(
      mindy,
      { autoAlpha: 0, scale: 0.97 },
      { autoAlpha: 1, scale: 1, duration: 0.9, ease: "power2.out" },
      "-=0.75",
    ).fromTo(
      previewWin,
      { autoAlpha: 0, scale: 0.97 },
      { autoAlpha: 1, scale: 1, duration: 0.9, ease: "power2.out" },
      "-=0.7",
    );

    // Type the install command once the copy has settled.
    tl.add(() => typeInstall(gsap), "-=0.2");
  });

  dashboard(ctx);
}
