// ServerMind setup wizard — `bun run setup`.
//
// Guided, re-runnable configuration that writes the ENTIRE .env: admin auth
// (password + TOTP), AI backend (Claude Code or any OpenAI-compatible API),
// networking, PM2, and optional MySQL/Redis with live connection tests.

import QRCode from "qrcode";
import { generateSecret, otpauthURL, verifyTotp } from "./auth/totp.ts";
import { ask, confirm, choose, heading, note, ok, warn, color as C, readEnv, upsertEnv } from "./wizard/io.ts";

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

async function which(bin: string): Promise<string> {
  try {
    const p = Bun.spawn(["sh", "-lc", `command -v ${bin}`], { stdout: "pipe", stderr: "ignore" });
    if ((await p.exited) === 0) return (await new Response(p.stdout).text()).trim();
  } catch {}
  return "";
}

// ── wizard ──────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${C.accent}${C.bold}  ServerMind setup${C.reset}`);
  note("Configures everything into .env. Press enter to keep a shown default.\n");
  const cur = await readEnv();
  const env: Record<string, string> = {};

  // ── 1. admin password ──
  heading("1 · Admin password");
  if (cur.get("SERVERMIND_PASSWORD_HASH") && !(await confirm("A password is already set. Change it?", false))) {
    note("Keeping existing password.");
  } else {
    let pw = "";
    for (;;) {
      pw = await ask("Choose a password (min 8 chars)", { hidden: true });
      if (pw.length < 8) { warn("Too short."); continue; }
      if ((await ask("Confirm password", { hidden: true })) !== pw) { warn("Didn't match."); continue; }
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
      { name: "Google Gemini (free, ~1,500/day)", base: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.0-flash", key: true },
      { name: "Groq (free, very fast)", base: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", key: true },
      { name: "OpenRouter", base: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.3-70b-instruct:free", key: true },
      { name: "Ollama (local, no key)", base: "http://127.0.0.1:11434/v1", model: "llama3.1", key: false },
      { name: "Custom OpenAI-compatible endpoint", base: "", model: "", key: true },
    ];
    const p = presets[await choose("Provider", presets.map((x) => x.name))]!;
    env.AI_BASE_URL = (await ask("API base URL", { def: p.base })).replace(/\/+$/, "");
    env.AI_MODEL = await ask("Model", { def: p.model });
    env.AI_API_KEY = p.key ? await ask("API key", { hidden: true, def: cur.get("AI_API_KEY") || "" }) : "";
    if (env.AI_API_KEY.includes("$")) warn("Key contains '$' which .env may mangle — regenerate a key without '$' if login fails.");
    if (await confirm("Test the connection now?", true)) {
      process.stdout.write("  testing… ");
      const t = await testAI(env.AI_BASE_URL, env.AI_API_KEY, env.AI_MODEL);
      console.log(t.ok ? `${C.green}ok${C.reset}` : `${C.red}failed${C.reset}`);
      if (!t.ok) warn(t.msg || "connection failed — you can fix AI_* in .env later.");
    }
  }

  // ── 4. networking ──
  heading("4 · Networking");
  env.BIND_HOST = await ask("Bind host", { def: cur.get("BIND_HOST") || "127.0.0.1" });
  env.PORT = await ask("Port", { def: cur.get("PORT") || "5500" });
  env.SECURE_COOKIES = (await confirm("Served over HTTPS (behind Caddy/Cloudflare)?", true)) ? "1" : "";

  // ── 5. PM2 ──
  heading("5 · PM2");
  note("PM2 is per-user. If your apps were started by a different user (e.g. root), point ServerMind at that daemon.");
  if (await confirm("Do your apps run under another user's PM2?", cur.get("PM2_COMMAND")?.includes("sudo") || false)) {
    const path = await ask("Full path to that pm2", { def: "/root/.bun/bin/pm2" });
    env.PM2_COMMAND = `sudo -n ${path}`;
    warn("Grant passwordless sudo for it (run as root):");
    console.log(`  ${C.dim}echo 'claudeuser ALL=(root) NOPASSWD: ${path} jlist, ${path} list, ${path} restart *, ${path} stop *, ${path} logs *' | sudo tee /etc/sudoers.d/servermind-pm2 && sudo chmod 440 /etc/sudoers.d/servermind-pm2${C.reset}`);
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

  // ── write ──
  await upsertEnv(env);
  heading("Done");
  ok(`Wrote ${Object.keys(env).length} settings to .env (chmod 600).`);
  console.log(`\n  Restart ServerMind to apply:\n    ${C.accent}pm2 reload servermind${C.reset}   ${C.dim}(or: bun run start)${C.reset}\n`);
  process.exit(0);
}

main().catch((e) => { console.error("setup failed:", e); process.exit(1); });
