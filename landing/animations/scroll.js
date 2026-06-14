/* ══════════════════════════════════════════════════════════════════════════
   animations/scroll.js — every ScrollTrigger-driven animation
   ----------------------------------------------------------------------------
   • Nav gains .scrolled (backdrop blur) once the page passes 80px
   • Badge marquee runs as an infinite GSAP tween (pauses on hover)
   • Numbered chapters slide in from the left, the "01/02/03" leading the rest
   • Section blocks (.reveal) fade + rise; re-adding .in keeps the legacy
     headline clip-wipe + underline-draw as a bonus
   • Feature cards stagger up off their grid container
   • Security shell-allowlist lines fade in one by one, then the ✓/✗ tokens
     flash green / red
   • "Three steps" pins on desktop and activates each step as you scrub past
   • CTA install block breathes with a subtle glow loop

   Only transforms + opacity are animated. matchMedia drops the pin and trims
   stagger on small screens; reduced-motion renders final states instantly.
   ══════════════════════════════════════════════════════════════════════════ */

// Reveal one .reveal element: rise + fade, flag .in for the CSS flourishes,
// and keep will-change on only for the life of the tween.
function revealOne(gsap, el, opts = {}) {
  gsap.fromTo(
    el,
    { y: opts.y ?? 24, autoAlpha: 0 },
    {
      y: 0,
      autoAlpha: 1,
      duration: opts.duration ?? 0.65,
      ease: "power3.out",
      willChange: "transform",
      scrollTrigger: { trigger: el, start: opts.start ?? "top 85%", once: true },
      onStart() {
        el.classList.add("in");
      },
      onComplete() {
        gsap.set(el, { willChange: "auto" });
      },
    },
  );
}

export function initScroll(ctx) {
  const { gsap, ScrollTrigger, reduced } = ctx;
  const isMobile = window.matchMedia("(max-width: 767px)").matches;

  /* ── Nav: .scrolled (blur) past 80px ── */
  const nav = document.querySelector(".nav");
  if (nav) {
    const setNav = (y) => nav.classList.toggle("scrolled", y > 80);
    ScrollTrigger.create({ start: 0, end: "max", onUpdate: (self) => setNav(self.scroll()) });
    setNav(window.scrollY);
  }

  // Collect reveals once, minus the ones owned by other routines.
  const reveals = gsap.utils
    .toArray(".reveal")
    .filter(
      (el) =>
        !el.closest(".hero") && // hero.js owns the above-the-fold entrance
        !el.classList.contains("card") && // feature cards animate off their grid
        !el.classList.contains("chapter"), // chapters get the left-slide treatment
    );

  /* ── Reduced motion: reveal everything, skip all movement/loops ── */
  if (reduced) {
    gsap.set([...reveals, ...gsap.utils.toArray(".chapter, .bento .card")], { autoAlpha: 1, x: 0, y: 0 });
    [...reveals, ...gsap.utils.toArray(".chapter")].forEach((el) => el.classList.add("in"));
    // Steps + security lines just sit in their final readable state.
    gsap.utils.toArray(".how-step").forEach((s) => s.classList.add("active"));
    return;
  }

  /* ── Section reveals ── */
  reveals.forEach((el) => revealOne(gsap, el));

  /* ── Numbered chapters: slide in from the left, number first ── */
  // The .chapter wrapper is a .reveal (CSS opacity:0); we leave it hidden until
  // its trigger fires (onStart), then slide its children — "01" leads the rest.
  gsap.utils.toArray(".chapter").forEach((ch) => {
    gsap.fromTo(
      gsap.utils.toArray(ch.children),
      { x: -40, autoAlpha: 0 },
      {
        x: 0,
        autoAlpha: 1,
        duration: 0.55,
        stagger: 0.1,
        ease: "power3.out",
        scrollTrigger: { trigger: ch, start: "top 80%", once: true },
        onStart() {
          ch.classList.add("in");
          gsap.set(ch, { autoAlpha: 1 });
        },
      },
    );
  });

  /* ── Feature cards: stagger up off the bento grid ── */
  const cards = gsap.utils.toArray(".bento .card");
  if (cards.length) {
    gsap.fromTo(
      cards,
      { y: 50, autoAlpha: 0 },
      {
        y: 0,
        autoAlpha: 1,
        duration: 0.6,
        ease: "power2.out",
        stagger: isMobile ? 0.05 : 0.1, // trimmed on small screens
        scrollTrigger: { trigger: ".bento", start: "top 75%", once: true },
        onStart: () => cards.forEach((c) => c.classList.add("in")),
      },
    );
  }

  /* ── Infinite badge marquee ── */
  const track = document.querySelector(".marquee-track");
  if (track) {
    const loop = gsap.to(track, { xPercent: -50, duration: 18, ease: "none", repeat: -1 });
    const marquee = track.closest(".marquee");
    marquee.addEventListener("mouseenter", () => loop.pause());
    marquee.addEventListener("mouseleave", () => loop.resume());
  }

  /* ── Security: shell-allowlist types in line by line, then ✓/✗ flash ── */
  const code = document.querySelector("#security .code-card code");
  if (code) {
    // Wrap each physical line so we can reveal them in sequence. Newlines stay
    // between the spans so <pre> still lays the lines out correctly.
    const lines = code.innerHTML.split("\n");
    code.innerHTML = lines.map((l) => `<span class="code-line">${l.length ? l : "&nbsp;"}</span>`).join("\n");
    const lineEls = gsap.utils.toArray(".code-line", code);

    const flash = (sel, glow) =>
      gsap.utils.toArray(sel, code).forEach((el, i) =>
        gsap.fromTo(
          el,
          { textShadow: `0 0 0px ${glow}` },
          {
            textShadow: `0 0 12px ${glow}`,
            duration: 0.28,
            delay: 0.55 + i * 0.14,
            yoyo: true,
            repeat: 1,
            ease: "power1.inOut",
          },
        ),
      );

    gsap.fromTo(
      lineEls,
      { autoAlpha: 0 },
      {
        autoAlpha: 1,
        duration: 0.16,
        ease: "none",
        stagger: 0.09,
        scrollTrigger: { trigger: code, start: "top 78%", once: true },
        onComplete() {
          flash(".c-no", "rgba(248,113,113,.95)"); // rejected → red
          flash(".c-ok", "rgba(74,222,128,.95)"); //  allowed → green
        },
      },
    );
  }

  /* ── "Three steps": pin on desktop, activate each step as you scrub ── */
  const steps = gsap.utils.toArray(".how-step");
  const fill = document.getElementById("howFill");
  if (steps.length) {
    const mm = gsap.matchMedia();
    // Desktop: pin the section and light up one step at a time (previous fades
    // back via the existing .how-step / .active CSS).
    mm.add("(min-width: 768px)", () => {
      const st = ScrollTrigger.create({
        trigger: "#how",
        start: "top top",
        end: () => "+=" + steps.length * 0.7 * window.innerHeight,
        pin: true,
        scrub: 1,
        anticipatePin: 1,
        onUpdate(self) {
          const idx = Math.min(steps.length - 1, Math.floor(self.progress * steps.length));
          steps.forEach((s, k) => s.classList.toggle("active", k === idx));
          if (fill) fill.style.height = ((idx + 1) / steps.length) * 100 + "%";
        },
      });
      return () => st.kill();
    });
    // Mobile: no pin — reveal the cards in place.
    mm.add("(max-width: 767px)", () => {
      gsap.fromTo(
        steps,
        { y: 30, autoAlpha: 0 },
        {
          y: 0,
          autoAlpha: 1,
          duration: 0.5,
          stagger: 0.12,
          ease: "power2.out",
          scrollTrigger: { trigger: ".how-steps", start: "top 80%", once: true },
          onComplete: () => steps.forEach((s) => s.classList.add("active")),
        },
      );
    });
  }

  /* ── CTA: subtle glow loop on the install block ── */
  const ctaInstall = document.querySelector(".cta .install");
  if (ctaInstall) {
    gsap.to(ctaInstall, {
      boxShadow: "0 0 28px rgba(245,165,36,0.30)",
      repeat: -1,
      yoyo: true,
      duration: 1.9,
      ease: "sine.inOut",
    });
  }
}
