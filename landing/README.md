# ServerMind landing site

The marketing site for **servermind.dev**. Static, self-contained — `index.html`
+ `style.css` + `script.js`. No build step.

Design: Linear-inspired dark, sharing the app's palette (`#08090A`, indigo
`#5E6AD2`, Geist). Sections: hero + install command, feature grid, how-it-works,
security, final CTA, footer.

## Preview locally
```bash
cd landing
python3 -m http.server 4321    # or: bunx serve .
# open http://localhost:4321
```

## Deploy options

### A. Caddy on your VPS (serves the site + the install script)
Point `servermind.dev` DNS at your server, then in `/etc/caddy/Caddyfile`:
```caddy
servermind.dev {
    encode zstd gzip
    root * /var/www/servermind-landing
    file_server
}
```
Copy the `landing/` files to `/var/www/servermind-landing/`, drop your
`install.sh` in the same folder, then `systemctl reload caddy`. Now:
- `https://servermind.dev` → the landing page
- `https://servermind.dev/install.sh` → the installer

### B. Vercel / Netlify / Cloudflare Pages
Point the project at this `landing/` directory — no build command, output dir `.`.
Add `servermind.dev` as a custom domain. (Host `install.sh` separately, e.g. on
your VPS or GitHub raw, and link it.)

### C. GitHub Pages
Push `landing/` to a repo, enable Pages on that folder, set the custom domain to
`servermind.dev`.

## Before going live
- Replace the `https://github.com/` placeholder links with your real repo URL.
- Swap the install command if your final installer URL differs.
- Add an OG image (`og.png`, 1200×630) and reference it in the `<head>`.
