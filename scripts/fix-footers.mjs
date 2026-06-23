import { readFileSync, writeFileSync } from 'fs';

const FILES = ['docs.html', 'compare.html', 'use-cases.html', 'privacy.html', 'terms.html']
  .map((f) => `landing/${f}`);

const BRAND_SVG = `<span class="brand-logo sm"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3.4C16.89 3.4 19.75 7.48 19.75 13.8C19.75 17.27 19.75 16.66 19.14 18.7C18.32 19.21 18.32 20.12 17.1 20.12C16.08 20.12 15.57 18.8 14.55 18.8C13.53 18.8 13.22 20.12 12 20.12C10.78 20.12 10.47 18.8 9.45 18.8C8.43 18.8 7.92 20.12 6.9 20.12C5.88 20.12 5.68 19.21 4.86 18.7C4.25 16.66 4.25 17.27 4.25 13.8C4.25 7.48 7.11 3.4 12 3.4Z" fill="#F5A524"/><circle cx="9.76" cy="12.5" r="1.7" fill="#fff"/><circle cx="14.24" cy="12.5" r="1.7" fill="#fff"/></svg></span>`;

const BADGE = `<a class="footer-badge" href="https://saasbrowser.com/en/saas/1550406/servermind" target="_blank" rel="noopener">
        <img src="https://static-files.saasbrowser.com/saas-browser-badge-15.svg" alt="ServerMind - Discover new software products" width="200" loading="lazy" />
      </a>`;

// Matches: footer-brand block + footer-links block + footer-meta line.
const RE = /<div class="footer-brand">[\s\S]*?<\/div>\s*<div class="footer-links">([\s\S]*?)<\/div>\s*<div class="footer-meta">[^<]*<\/div>/;

for (const file of FILES) {
  let html = readFileSync(file, 'utf8');
  if (!RE.test(html)) { console.log(`SKIP (no match)  ${file}`); continue; }
  // Re-indent captured links from 6 spaces to 8 spaces for the new nesting.
  html = html.replace(RE, (_m, links) => {
    const relinked = links.replace(/\n {6}<a /g, '\n        <a ');
    return `<div class="footer-top">
      <div class="footer-brand">
        ${BRAND_SVG}
        ServerMind
      </div>
      <nav class="footer-links">${relinked}</nav>
    </div>
    <div class="footer-bottom">
      <div class="footer-meta">Open-source · Self-hosted · MIT · © 2026 Ajjlal Ahmed</div>
      ${BADGE}
    </div>`;
  });
  writeFileSync(file, html);
  console.log(`OK  ${file}`);
}
