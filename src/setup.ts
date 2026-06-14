// ServerMind setup wizard — `bun run setup`.
//
// Guided, re-runnable configuration that writes the ENTIRE .env: admin auth
// (password + TOTP), AI backend (Claude Code or any OpenAI-compatible API),
// networking, PM2, and optional MySQL/Redis with live connection tests.

import QRCode from "qrcode";
import { generateSecret, otpauthURL, verifyTotp } from "./auth/totp.ts";
import { ask, confirm, choose, heading, banner, field, note, ok, warn, color as C, readEnv, upsertEnv } from "./wizard/io.ts";
import { smtpSend, resendSend } from "./notify/email.ts";

// ── live tests ────────────────────────────────────────────────────────────────
async function testAI(base: string, key: string, model: string): Promise<{ ok: boolean; msg?: string }> {
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
    });
    if (r.ok) return { ok: true };
    return { ok: false, msg: `HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 140)}` };
  } catch (e) {
    return { ok: false, msg: (e as Error).message };
  }
}

async function testMysql(host: string, port: string, user: string, pass: string): Promise<{ ok: boolean; msg?: string }> {
  try {
    const p = Bun.spawn(["mysql", "-h", host, "-P", port, "--protocol=TCP", "-u", user, "-N", "-e", "SELECT 1"], {
      env: { ...process.env, MYSQL_PWD: pass }, stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    const code = await p.exited;
    if (code === 0) return { ok: true };
    return { ok: false, msg: (await new Response(p.stderr).text()).trim().slice(0, 140) };
  } catch (e) {
    return { ok: false, msg: (e as Error).message };
  }
}

function testRedis(host: string, port: number): Promise<{ ok: boolean; msg?: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: { ok: boolean; msg?: string }) => { if (!done) { done = true; resolve(r); } };
    const timer = setTimeout(() => finish({ ok: false, msg: "timeout" }), 3000);
    Bun.connect({
      hostname: host, port,
      socket: {
        open(s) { s.write("PING\r\n"); },
        data(s, d) { clearTimeout(timer); const pong = d.toString().includes("PONG"); s.end(); finish(pong ? { ok: true } : { ok: false, msg: "no PONG (auth required?)" }); },
        error(_s, e) { clearTimeout(timer); finish({ ok: false, msg: String(e) }); },
      },
    }).catch((e) => { clearTimeout(timer); finish({ ok: false, msg: String(e) }); });
  });
}

async function testEmail(env: Record<string, string>): Promise<{ ok: boolean; msg?: string }> {
  const subject = "ServerMind test email ✓";
  const text = "This is a test from the ServerMind setup wizard.\nIf you got this, email reports & alerts are working.\n\n— ServerMind";
  try {
    if (env.EMAIL_METHOD === "resend") {
      await resendSend(env.RESEND_API_KEY || "", { from: env.EMAIL_FROM || "ServerMind <onboarding@resend.dev>", to: env.EMAIL_TO || "", subject, text });
    } else {
      await smtpSend({ host: env.SMTP_HOST || "", port: Number(env.SMTP_PORT) || 465, user: env.SMTP_USER || "", pass: env.SMTP_PASS || "", from: env.EMAIL_FROM || env.SMTP_USER || "", to: env.EMAIL_TO || "", subject, text });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: (e as Error).message };
  }
}

async function which(bin: string): Promise<string> {
  try {
    const p = Bun.spawn(["sh", "-lc", `command -v ${bin}`], { stdout: "pipe", stderr: "ignore" });
    if ((await p.exited) === 0) return (await new Response(p.stdout).text()).trim();
  } catch {}
  return "";
}

async function detectProxies(): Promise<{ caddy: string; nginx: string }> {
  const [caddy, nginx] = await Promise.all([which("caddy"), which("nginx")]);
  return { caddy, nginx };
}

// Best-effort hunt for a pm2 binary, so the operator doesn't have to know the
// path. Returns the distinct candidates that actually exist, most-likely first.
async function findPm2(): Promise<string[]> {
  const found: string[] = [];
  const add = (p: string) => { if (p && !found.includes(p)) found.push(p); };
  add(await which("pm2")); // current user's PATH
  for (const c of ["/root/.bun/bin/pm2", "/usr/local/bin/pm2", "/usr/bin/pm2", "/root/.npm-global/bin/pm2", "/root/.yarn/bin/pm2"]) {
    if (await Bun.file(c).exists()) add(c);
  }
  return found;
}

// Ready-to-paste reverse-proxy snippets. Both disable response buffering so the
// chat's Server-Sent-Events stream isn't held back, and pass X-Forwarded-Proto
// so ServerMind marks the session cookie Secure (see auth/session.ts).
function caddyBlock(domain: string, port: string): string {
  return [
    "",
    `    ${domain} {`,
    `        reverse_proxy 127.0.0.1:${port} {`,
    `            flush_interval -1      # stream SSE (chat) without buffering`,
    `        }`,
    `    }`,
    "",
  ].join("\n");
}

function nginxBlock(domain: string, port: string): string {
  return [
    "",
    `    server {`,
    `        server_name ${domain};`,
    `        location / {`,
    `            proxy_pass http://127.0.0.1:${port};`,
    `            proxy_http_version 1.1;`,
    `            proxy_set_header Host $host;`,
    `            proxy_set_header X-Forwarded-Proto $scheme;`,
    `            proxy_buffering off;          # stream SSE (chat)`,
    `            proxy_read_timeout 300s;`,
    `        }`,
    `    }`,
    "",
  ].join("\n");
}

// ── wizard ──────────────────────────────────────────────────────────────────
async function main() {
  banner("ServerMind · setup", "Configure auth, AI, networking, services & email — saved to .env");
  note("Press Enter to accept the (grey) default. Hidden fields don't echo as you type.");
  const cur = await readEnv();
  const env: Record<string, string> = {};

  // ── 1. admin password ──
  heading("1 · Admin password");
  if (cur.get("SERVERMIND_PASSWORD_HASH") && !(await confirm("A password is already set. Change it?", false))) {
    note("Keeping existing password.");
  } else {
    note("Typing is hidden — you won't see the characters. Press enter when done.");
    let pw = "";
    for (;;) {
      pw = await ask("Choose a password — at least 8 characters", { hidden: true });
      if (pw.length < 8) { warn("Too short — use at least 8 characters."); continue; }
      const pw2 = await ask("Confirm password — type the same one again", { hidden: true });
      if (pw2 !== pw) { warn("Those didn't match — let's try again."); continue; }
      break;
    }
    env.SERVERMIND_PASSWORD_HASH = Buffer.from(await Bun.password.hash(pw, "argon2id"), "utf8").toString("base64");
    ok("Password set.");
  }

  // ── 2. two-factor ──
  heading("2 · Two-factor (TOTP)");
  if (cur.get("SERVERMIND_TOTP_SECRET") && !(await confirm("2FA is already set. Re-enroll (new QR)?", false))) {
    note("Keeping existing TOTP secret.");
  } else {
    const secret = generateSecret();
    const label = (await ask("Account label", { def: "admin@servermind" })) || "admin@servermind";
    console.log("\n  Scan with Google Authenticator / Authy / 1Password:\n");
    console.log(await QRCode.toString(otpauthURL(secret, label), { type: "terminal", small: true }));
    console.log(`  ${C.dim}Or enter this key manually:${C.reset} ${secret}\n`);
    for (;;) {
      const code = await ask("Enter the 6-digit code to confirm");
      if (verifyTotp(secret, code)) { env.SERVERMIND_TOTP_SECRET = secret; ok("2FA verified."); break; }
      warn("Didn't match — wait for the next code.");
    }
  }

  // ── 3. AI backend ──
  heading("3 · AI backend");
  const backend = await choose("How should ServerMind think?", [
    "Claude Code — your Claude subscription (no API key)",
    "Free / your own API — Gemini, Groq, OpenRouter, Ollama…",
  ], cur.get("AI_BACKEND") === "openai" ? 1 : 0);

  if (backend === 0) {
    env.AI_BACKEND = "claude-code";
    const detected = await which("claude");
    const bin = await ask("Path to the claude binary", { def: cur.get("CLAUDE_BIN") || detected || "claude" });
    if (bin && bin !== "claude") env.CLAUDE_BIN = bin;
    if (!detected) warn("`claude` not found on PATH — install Claude Code and `claude login` before chatting.");
    else ok(`Using Claude Code (${detected}).`);
  } else {
    env.AI_BACKEND = "openai";
    const presets = [
      { name: "Google Gemini (free, ~1,500/day)", base: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.0-flash", key: true, keyUrl: "https://aistudio.google.com/apikey" },
      { name: "Groq — fast inference (api.groq.com, gsk_ keys)", base: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", key: true, keyUrl: "https://console.groq.com/keys" },
      { name: "xAI Grok — Elon's Grok (api.x.ai, xai- keys)", base: "https://api.x.ai/v1", model: "grok-3", key: true, keyUrl: "https://console.x.ai" },
      { name: "OpenRouter", base: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.3-70b-instruct:free", key: true, keyUrl: "https://openrouter.ai/keys" },
      { name: "Ollama (local, no key)", base: "http://127.0.0.1:11434/v1", model: "llama3.1", key: false, keyUrl: "" },
      { name: "Custom OpenAI-compatible endpoint", base: "", model: "", key: true, keyUrl: "" },
    ];
    // "Groq" (fast inference) and "xAI Grok" sound alike but are different services
    // with different keys — flag it so nobody pastes one into the other.
    note('Heads up: "Groq" and "xAI Grok" are different services — pick the one your key is for.');
    // Pre-select the provider you're ALREADY using, so re-running setup (e.g. to
    // update) and pressing enter keeps your config instead of resetting to Gemini.
    const curBase = cur.get("AI_BASE_URL") || "";
    let defIdx = 0;
    if (curBase) {
      const i = presets.findIndex((x) => x.base && x.base === curBase);
      defIdx = i >= 0 ? i : presets.length - 1; // matched a preset, else "Custom"
    }
    const choice = await choose("Provider", presets.map((x) => x.name), defIdx);
    const p = presets[choice]!;
    const kept = choice === defIdx && curBase !== ""; // staying on the same provider
    if (p.base === "https://api.x.ai/v1") note("If the model errors, list valid ids: curl https://api.x.ai/v1/models -H \"Authorization: Bearer <key>\"");
    // Default to your existing URL/model when you keep the same provider; only
    // fall back to the preset's defaults when you actually switch providers.
    env.AI_BASE_URL = (await ask("API base URL", { def: kept ? curBase : p.base })).replace(/\/+$/, "");
    env.AI_MODEL = await ask("Model", { def: kept && cur.get("AI_MODEL") ? cur.get("AI_MODEL")! : p.model });

    // API key. This is the step people skip by accident — so make it loud, show
    // where to get one, and don't let an empty key slip through silently.
    if (p.key) {
      console.log("");
      note("This provider needs an API key — without it the assistant won't work.");
      if (p.keyUrl) note(`Get a free key here, then paste it below:  ${C.accent}${p.keyUrl}${C.reset}`);
      const existing = cur.get("AI_API_KEY") || "";
      for (;;) {
        const k = (await ask(existing ? "Paste your API key (enter to keep the saved one)" : "Paste your API key (required)", { hidden: true, def: existing })).trim();
        if (k) { env.AI_API_KEY = k; break; }
        warn("No key entered — the AI will NOT work until you set one.");
        if (await confirm("Skip for now and add AI_API_KEY to .env later?", false)) { env.AI_API_KEY = ""; break; }
      }
    } else {
      env.AI_API_KEY = "";
    }
    if (env.AI_API_KEY.includes("$")) warn("Key contains '$' which .env may mangle — regenerate a key without '$' if login fails.");

    if (env.AI_API_KEY || !p.key) {
      let testing = await confirm("Test the connection now?", true);
      while (testing) {
        process.stdout.write("  testing… ");
        const t = await testAI(env.AI_BASE_URL, env.AI_API_KEY, env.AI_MODEL);
        if (t.ok) { console.log(`${C.green}ok${C.reset}`); break; }
        console.log(`${C.red}failed${C.reset}`);
        warn(t.msg || "connection failed");
        // 429 = the key authenticated fine but hit a quota/rate cap — not a config error.
        if ((t.msg || "").includes("429")) {
          note("HTTP 429 means your key works but hit a quota/rate limit. You can continue —");
          note("it usually clears within a minute (free tiers reset per-minute).");
        }
        // Let the operator go back and edit instead of being stuck.
        const fix = await choose("What now?", [
          "Re-enter the API key, then test again",
          "Change the model, then test again",
          "Change the base URL, then test again",
          "Continue anyway (you can fix AI_* in .env later)",
        ]);
        if (fix === 0) env.AI_API_KEY = (await ask("Paste your API key", { hidden: true, def: env.AI_API_KEY })).trim();
        else if (fix === 1) env.AI_MODEL = await ask("Model", { def: env.AI_MODEL });
        else if (fix === 2) env.AI_BASE_URL = (await ask("API base URL", { def: env.AI_BASE_URL })).replace(/\/+$/, "");
        else testing = false; // continue anyway
      }
    } else {
      warn("Skipping the test — no key set. Add AI_API_KEY to .env and run: pm2 reload servermind");
    }
  }

  // ── 4. access & networking ──
  heading("4 · Access & networking");
  note("ServerMind serves its own UI. You reach it either privately (no domain");
  note("needed) or through a reverse proxy on a domain. Pick what fits you.");
  const access = await choose("How will you reach the web UI?", [
    "Private — SSH tunnel or Tailscale (no domain or TLS needed — recommended to start)",
    "Public domain over HTTPS — behind Caddy or Nginx",
  ], cur.get("SECURE_COOKIES") ? 1 : 0);

  const port = await ask("Port", { def: cur.get("PORT") || "5500" });
  env.PORT = port;

  let domain = "";
  if (access === 1) {
    // Public domain: the proxy connects to ServerMind on localhost, and the
    // session cookie should be marked Secure (we're terminating TLS up front).
    env.BIND_HOST = "127.0.0.1";
    env.SECURE_COOKIES = "1";
    domain = await ask("Your domain (e.g. servermind.example.com)", { def: cur.get("SERVERMIND_DOMAIN") || "" });
    if (domain) env.SERVERMIND_DOMAIN = domain;

    const { caddy, nginx } = await detectProxies();
    const d = domain || "your-domain.com";
    if (caddy) {
      ok("Caddy detected — it gets a TLS cert automatically.");
      note("Add this to /etc/caddy/Caddyfile, then: sudo systemctl reload caddy");
      console.log(`${C.dim}${caddyBlock(d, port)}${C.reset}`);
    } else if (nginx) {
      ok("Nginx detected.");
      note("Add this server block, get a cert (sudo certbot --nginx), then: sudo nginx -s reload");
      console.log(`${C.dim}${nginxBlock(d, port)}${C.reset}`);
    } else {
      warn("Neither Caddy nor Nginx is installed.");
      note("ServerMind still runs fine without them — they only terminate HTTPS for a");
      note("domain. Easiest path is Caddy (auto-HTTPS, one line of config):");
      console.log(`    ${C.accent}# Debian/Ubuntu${C.reset} ${C.dim}sudo apt install -y caddy${C.reset}`);
      console.log(`    ${C.dim}# others: https://caddyserver.com/docs/install${C.reset}`);
      console.log(`${C.dim}${caddyBlock(d, port)}${C.reset}`);
      note("No proxy and no domain? Skip this — use an SSH tunnel or Tailscale instead (shown below).");
    }
  } else {
    // Private: stay on localhost (or a tailnet IP). Plain HTTP over an SSH
    // tunnel / tailnet is fine — credentials never cross the open internet — so
    // the cookie is left non-Secure to keep it working on http://localhost.
    env.SECURE_COOKIES = "";
    const host = await ask("Bind host", { def: cur.get("BIND_HOST") || "127.0.0.1" });
    env.BIND_HOST = host;
    note("Tip: set the bind host to this server's Tailscale IP to reach it across your tailnet.");
  }

  // ── 5. PM2 ──
  heading("5 · PM2");
  note("PM2 is per-user. If your apps were started by a different user (e.g. root), point ServerMind at that daemon.");
  if (await confirm("Do your apps run under another user's PM2?", cur.get("PM2_COMMAND")?.includes("sudo") || false)) {
    const detected = await findPm2();
    if (detected.length) {
      ok(`Found pm2 at: ${detected.join("  ·  ")}`);
    } else {
      note("Couldn't auto-detect pm2. Don't know the path? Run this as that user and copy the result:");
      console.log(`    ${C.accent}sudo -u root which pm2${C.reset}   ${C.dim}# common spot: /root/.bun/bin/pm2${C.reset}`);
    }
    const prev = cur.get("PM2_COMMAND")?.split(/\s+/).pop();
    const path = await ask("Full path to that pm2", { def: detected[0] || prev || "/root/.bun/bin/pm2" });
    env.PM2_COMMAND = `sudo -n ${path}`;
    note("If this path is wrong, ServerMind still runs fine — only the PM2 panel stays empty.");
    note("You can fix PM2_COMMAND in .env and run `pm2 reload servermind` anytime.");
    warn("Grant passwordless sudo for it (run as root, replacing <user> with the user ServerMind runs as):");
    console.log(`  ${C.dim}echo '<user> ALL=(root) NOPASSWD: ${path} jlist, ${path} list, ${path} restart *, ${path} stop *, ${path} logs *' | sudo tee /etc/sudoers.d/servermind-pm2 && sudo chmod 440 /etc/sudoers.d/servermind-pm2${C.reset}`);
  } else {
    env.PM2_COMMAND = "pm2";
  }

  // ── 6. monitored services ──
  heading("6 · Monitored services");
  env.MONITORED_UNITS = await ask("systemd units to show on the dashboard (comma-separated)", {
    def: cur.get("MONITORED_UNITS") || "nginx,caddy,mysql,mariadb,redis-server",
  });

  // ── 7. MySQL ──
  heading("7 · MySQL (optional)");
  if (await confirm("Monitor MySQL?", !!cur.get("MYSQL_USER"))) {
    env.MYSQL_HOST = await ask("Host", { def: cur.get("MYSQL_HOST") || "127.0.0.1" });
    env.MYSQL_PORT = await ask("Port", { def: cur.get("MYSQL_PORT") || "3306" });
    env.MYSQL_USER = await ask("User", { def: cur.get("MYSQL_USER") || "root" });
    env.MYSQL_PASSWORD = await ask("Password", { hidden: true, def: cur.get("MYSQL_PASSWORD") || "" });
    if (env.MYSQL_PASSWORD.includes("$")) warn("Password contains '$' which .env may mangle.");
    process.stdout.write("  testing… ");
    const t = await testMysql(env.MYSQL_HOST, env.MYSQL_PORT, env.MYSQL_USER, env.MYSQL_PASSWORD);
    console.log(t.ok ? `${C.green}ok${C.reset}` : `${C.red}failed${C.reset}`);
    if (!t.ok) warn(t.msg || "connection failed");
  } else {
    note("Skipped.");
  }

  // ── 8. Redis ──
  heading("8 · Redis (optional)");
  if (await confirm("Monitor Redis?", true)) {
    env.REDIS_HOST = await ask("Host", { def: cur.get("REDIS_HOST") || "127.0.0.1" });
    env.REDIS_PORT = await ask("Port", { def: cur.get("REDIS_PORT") || "6379" });
    process.stdout.write("  testing… ");
    const t = await testRedis(env.REDIS_HOST, Number(env.REDIS_PORT));
    console.log(t.ok ? `${C.green}ok${C.reset}` : `${C.red}failed${C.reset}`);
    if (!t.ok) warn(t.msg || "connection failed");
  } else {
    note("Skipped.");
  }

  // ── 9. Email reports & alerts ──
  heading("9 · Email reports & alerts (optional)");
  note("Get a daily health report by email, plus alerts when disk/memory is high");
  note("or a monitored service goes down. Sends via your Gmail/SMTP or Resend.");
  if (await confirm("Enable email reports & alerts?", !!cur.get("EMAIL_ENABLED"))) {
    env.EMAIL_ENABLED = "1";
    env.EMAIL_TO = await ask("Send reports TO (your email address)", { def: cur.get("EMAIL_TO") || "" });

    const method = await choose("How should it send mail?", [
      "SMTP — Gmail or your own mail server",
      "Resend — API key (simplest, best inbox delivery, free tier)",
    ], cur.get("EMAIL_METHOD") === "resend" ? 1 : 0);

    if (method === 1) {
      env.EMAIL_METHOD = "resend";
      note("Free key at https://resend.com . To send from your own domain, verify it there;");
      note("for a quick test you can send From: 'ServerMind <onboarding@resend.dev>'.");
      env.RESEND_API_KEY = (await ask("Resend API key (re_…)", { hidden: true, def: cur.get("RESEND_API_KEY") || "" })).trim();
      env.EMAIL_FROM = await ask("From address", { def: cur.get("EMAIL_FROM") || "ServerMind <onboarding@resend.dev>" });
    } else {
      env.EMAIL_METHOD = "smtp";
      note("Gmail: host smtp.gmail.com · port 465 · user = your full gmail · pass = an APP PASSWORD");
      note("Create an app password at https://myaccount.google.com/apppasswords (NOT your login password).");
      env.SMTP_HOST = await ask("SMTP host", { def: cur.get("SMTP_HOST") || "smtp.gmail.com" });
      env.SMTP_PORT = await ask("SMTP port (use 465)", { def: cur.get("SMTP_PORT") || "465" });
      env.SMTP_USER = await ask("SMTP username (full email)", { def: cur.get("SMTP_USER") || env.EMAIL_TO || "" });
      env.SMTP_PASS = (await ask("SMTP password / app password", { hidden: true, def: cur.get("SMTP_PASS") || "" })).trim();
      if (env.SMTP_PASS.includes("$")) warn("Password contains '$' which .env may mangle — app passwords normally don't.");
      env.EMAIL_FROM = await ask("From address", { def: cur.get("EMAIL_FROM") || env.SMTP_USER });
    }

    // schedule + thresholds
    const hour = await ask("Daily report hour, 0–23 server time (blank = alerts only)", { def: cur.get("DIGEST_HOUR") || "8" });
    if (hour.trim() !== "") env.DIGEST_HOUR = String(Math.max(0, Math.min(23, Math.round(Number(hour)) || 0)));
    env.ALERT_DISK_PCT = await ask("Alert when disk usage % is above", { def: cur.get("ALERT_DISK_PCT") || "90" });
    env.ALERT_MEM_PCT = await ask("Alert when memory usage % is above", { def: cur.get("ALERT_MEM_PCT") || "90" });

    if (await confirm("Send a test email now?", true)) {
      process.stdout.write("  sending… ");
      const t = await testEmail(env);
      console.log(t.ok ? `${C.green}sent${C.reset}` : `${C.red}failed${C.reset}`);
      if (t.ok) note(`Check ${env.EMAIL_TO} (and the spam folder the first time).`);
      else warn(t.msg || "send failed — fix the EMAIL_*/SMTP_* values in .env, or re-run setup");
    }
  } else {
    env.EMAIL_ENABLED = "";
    note("Skipped. Enable it anytime with `bun run setup`.");
  }

  // ── write ──
  await upsertEnv(env);
  heading("Done");
  ok(`Wrote ${Object.keys(env).length} settings to .env (chmod 600).`);

  // Compact recap of the key choices.
  console.log("");
  field("AI", env.AI_BACKEND === "claude-code" ? "Claude Code (subscription)" : (env.AI_MODEL || "OpenAI-compatible"));
  field("Access", access === 1 ? (domain ? `https://${domain}` : "public domain (reverse proxy)") : "private (localhost / SSH tunnel)");
  field("Email", env.EMAIL_ENABLED === "1" ? `on → ${env.EMAIL_TO}` : "off");

  // How to actually open the UI, tailored to the access method chosen above.
  console.log(`\n  ${C.bold}Reaching the UI:${C.reset}`);
  if (access === 1 && domain) {
    console.log(`    Once your reverse proxy is live:  ${C.accent}https://${domain}${C.reset}`);
  } else if (access === 1) {
    console.log(`    Through your reverse proxy, on the domain you point at 127.0.0.1:${port}.`);
  } else {
    console.log(`    From your laptop, tunnel over SSH (nothing is exposed publicly):`);
    console.log(`      ${C.accent}ssh -L ${port}:127.0.0.1:${port} <user>@<this-server>${C.reset}`);
    console.log(`    then open  ${C.accent}http://localhost:${port}${C.reset}`);
    console.log(`    ${C.dim}Or: Tailscale (set BIND_HOST to the tailnet IP), or a quick tunnel:${C.reset}`);
    console.log(`    ${C.dim}  cloudflared tunnel --url http://127.0.0.1:${port}${C.reset}`);
  }

  console.log(`\n  Restart ServerMind to apply:\n    ${C.accent}pm2 reload servermind${C.reset}   ${C.dim}(or: bun run start)${C.reset}\n`);
  process.exit(0);
}

main().catch((e) => { console.error("setup failed:", e); process.exit(1); });
