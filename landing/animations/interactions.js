/* ══════════════════════════════════════════════════════════════════════════
   animations/interactions.js — hover + micro-interactions
   ----------------------------------------------------------------------------
   • Button lift: every .btn rises 2px on hover (GitHub buttons excluded — they
     get their own shake instead, to avoid two tweens fighting over transform)
   • Nav links: an underline wipes in from the left (GSAP tweens a --ul CSS var
     that an ::after pseudo reads for scaleX)
   • GitHub "Star" buttons: a short, springy shake timeline on hover
   • FAQ accordion: height + fade open/close, single-open, replacing the native
     instant toggle and the legacy CSS

   Reduced-motion keeps a no-animation single-open accordion and nothing else.
   ══════════════════════════════════════════════════════════════════════════ */

export function initInteractions(ctx) {
  const { gsap, reduced } = ctx;
  const fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const isGithub = (a) => /github\.com/.test(a.getAttribute("href") || "");

  /* ── FAQ accordion (runs in every motion mode) ── */
  const items = gsap.utils.toArray(".faq-item");
  if (reduced) {
    // No animation — just enforce single-open via the native toggle event.
    items.forEach((item) =>
      item.addEventListener("toggle", () => {
        if (item.open) items.forEach((o) => o !== item && (o.open = false));
      }),
    );
  } else {
    const open = (item, ans) => {
      item.open = true; // reveal so GSAP can measure the natural height
      gsap.from(ans, {
        height: 0,
        autoAlpha: 0,
        duration: 0.35,
        ease: "power2.out",
        onComplete: () => gsap.set(ans, { height: "auto", clearProps: "height" }),
      });
    };
    const close = (item, ans) =>
      gsap.to(ans, {
        height: 0,
        autoAlpha: 0,
        duration: 0.25,
        ease: "power2.in",
        onComplete: () => {
          item.open = false;
          gsap.set(ans, { clearProps: "height,opacity,visibility" });
        },
      });

    items.forEach((item) => {
      const summary = item.querySelector("summary");
      const ans = item.querySelector(".faq-a");
      if (!summary || !ans) return;
      summary.addEventListener("click", (e) => {
        e.preventDefault(); // take over the native open/close
        if (item.open) {
          close(item, ans);
        } else {
          items.forEach((o) => o !== item && o.open && close(o, o.querySelector(".faq-a")));
          open(item, ans);
        }
      });
    });
  }

  // The rest are hover affordances — pointer devices only, motion allowed.
  if (reduced || !fine) return;

  /* ── Button lift on hover ── */
  gsap.utils.toArray("a.btn").forEach((btn) => {
    if (isGithub(btn)) return; // handled by the shake below
    btn.addEventListener("mouseenter", () => gsap.to(btn, { y: -2, duration: 0.2, ease: "power2.out" }));
    btn.addEventListener("mouseleave", () => gsap.to(btn, { y: 0, duration: 0.2, ease: "power2.out" }));
  });

  /* ── Nav-link underline wipe (drives --ul → ::after scaleX) ── */
  gsap.utils.toArray(".nav-links a").forEach((a) => {
    a.addEventListener("mouseenter", () => gsap.to(a, { "--ul": 1, duration: 0.25, ease: "power2.out" }));
    a.addEventListener("mouseleave", () => gsap.to(a, { "--ul": 0, duration: 0.2, ease: "power2.in" }));
  });

  /* ── GitHub buttons: a short springy shake on hover ── */
  gsap.utils.toArray("a.btn").forEach((btn) => {
    if (!isGithub(btn)) return;
    const shake = gsap
      .timeline({ paused: true })
      .to(btn, { y: -2, duration: 0.12, ease: "power2.out" })
      .to(btn, { rotation: -4, duration: 0.06 })
      .to(btn, { rotation: 3, duration: 0.06 })
      .to(btn, { rotation: -2, duration: 0.06 })
      .to(btn, { rotation: 0, y: 0, duration: 0.1, ease: "power2.out" });
    btn.addEventListener("mouseenter", () => shake.restart());
  });
}
