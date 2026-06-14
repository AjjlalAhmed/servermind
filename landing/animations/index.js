/* ══════════════════════════════════════════════════════════════════════════
   animations/index.js — GSAP motion entry point for servermind.dev
   ----------------------------------------------------------------------------
   Buildless setup: GSAP core + ScrollTrigger + SplitText are loaded as classic
   UMD <script> tags from the jsDelivr CDN in index.html (so there is exactly
   ONE gsap instance and the plugins attach to it cleanly). This ES module reads
   them off `window`, registers them, and wires up the three animation layers:

       hero.js          — page-load + hero/dashboard intro
       scroll.js        — every ScrollTrigger-driven animation
       interactions.js  — hover + micro-interactions

   The html.sm-gsap flag was already set by the inline boot script in <head>
   (so the legacy JS in script.js / award.js stood down before running). Here we
   confirm the runtime is alive (sm-gsap-ready) or, if GSAP failed to load, fall
   back to a static page (sm-gsap-failed).
   ══════════════════════════════════════════════════════════════════════════ */

import { initHero } from "./hero.js";
import { initScroll } from "./scroll.js";
import { initInteractions } from "./interactions.js";

const root = document.documentElement;
const gsap = window.gsap;
const ScrollTrigger = window.ScrollTrigger;
const SplitText = window.SplitText; // free since GSAP 3.13; may be undefined — callers guard

// GSAP CDN blocked / failed to parse → bail to the static failsafe.
if (!gsap || !ScrollTrigger) {
  root.classList.add("sm-gsap-failed");
} else {
  gsap.registerPlugin(ScrollTrigger);
  if (SplitText) gsap.registerPlugin(SplitText);

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Shared context handed to every layer.
  const ctx = { gsap, ScrollTrigger, SplitText, reduced };

  // Defaults that read like a fast, premium dev tool: quick, eased, never bouncy.
  gsap.defaults({ ease: "power3.out", duration: 0.6 });

  const boot = () => {
    initHero(ctx);
    initScroll(ctx);
    initInteractions(ctx);

    // Layout depends on web fonts (Geist / Geist Mono) — recalc trigger
    // positions once they settle so pins/scrubs start at the right scroll Y.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => ScrollTrigger.refresh());
    }
    window.addEventListener("load", () => ScrollTrigger.refresh());

    root.classList.add("sm-gsap-ready");
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
}
