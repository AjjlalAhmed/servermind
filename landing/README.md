# ServerMind landing site

The marketing site for **servermind.dev**. Static, self-contained, no build step.

Design: Linear-inspired dark — amber accent (`#F5A524` / `#FBBF24`) on near-black
`#0B0A07`, Geist (sans + mono). Mindy, the daemon mascot, leads the hero.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Landing page (hero, features, how-it-works, security, FAQ, CTA) |
| `docs.html` | Setup guide (requirements → install → AI → access → uninstall → security → troubleshooting) |
| `style.css` / `script.js` / `award.js` | Styles + interactions (shared by both pages) |
| `favicon.svg` | Site icon (the Mindy daemon) |
| `og.png` | Social share card, 1200×630 |
| `og-source.html` | Editable source for `og.png` (regen command in its header comment) |
| `robots.txt` | Allows search + AI crawlers (GPTBot, PerplexityBot, ClaudeBot, Google-Extended…) |
| `sitemap.xml` | Lists `/` and `/docs.html` |
| `llms.txt` | Plain-text brief for LLMs (GEO) |
| `mascot/` | Standalone mascot playground (unlinked; optional to deploy) |

`og.png`, `robots.txt`, `sitemap.xml`, and `llms.txt` are referenced at the site
**root**, so they must be served from `https://servermind.dev/<file>`.

## Preview locally
```bash
cd landing
python3 -m http.server 4321    # or: bunx serve .
# open http://localhost:4321
```

## Deploy

The site root must serve the `landing/` files **plus** `install.sh` and
`uninstall.sh` (which live at the repo root, not in `landing/`), so that:

- `https://servermind.dev` → landing page
- `https://servermind.dev/docs.html` → setup guide
- `https://servermind.dev/install.sh` → installer (`curl … | bash`)
- `https://servermind.dev/uninstall.sh` → uninstaller
- `https://servermind.dev/og.png` · `/robots.txt` · `/sitemap.xml` · `/llms.txt`

### A. Caddy on your VPS
Point `servermind.dev` DNS at your server, then in `/etc/caddy/Caddyfile`:
```caddy
servermind.dev {
    encode zstd gzip
    root * /var/www/servermind-site
    file_server
}
```
```bash
mkdir -p /var/www/servermind-site
cp -r landing/* /var/www/servermind-site/
cp install.sh uninstall.sh /var/www/servermind-site/   # from the repo root
systemctl reload caddy
```

### B. Vercel / Netlify / Cloudflare Pages
Point the project at the `landing/` directory — no build command, output dir `.`
— and add `servermind.dev` as a custom domain. Then host `install.sh` and
`uninstall.sh` at the root too (copy them into `landing/` for the deploy, or
serve them via a redirect/rewrite to GitHub raw).

### C. GitHub Pages
Publish `landing/` and set the custom domain to `servermind.dev`. Copy
`install.sh` / `uninstall.sh` into the published folder so the root URLs resolve.

## After going live
- Submit `https://servermind.dev/sitemap.xml` in Google Search Console.
- Verify the OG card renders (paste the URL into Slack/X, or use a card
  validator). Regenerate `og.png` from `og-source.html` if you edit the copy.
- Sanity-check `curl -fsSL https://servermind.dev/install.sh | bash` resolves.
