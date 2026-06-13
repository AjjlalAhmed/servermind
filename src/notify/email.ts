// Email delivery for reports & alerts. Two methods, no dependencies:
//   - resend: a single HTTPS call to the Resend API (best deliverability)
//   - smtp:   a minimal SMTP-over-TLS client (port 465) — works with Gmail
//             (app password) or any standard relay.
// We deliberately do NOT run a local mail server: VPS IPs are usually
// blacklisted, port 25 is often blocked, and you'd need SPF/DKIM/DMARC/PTR —
// mail would just land in spam. Relaying through a real provider is reliable.

import { config } from "../config.ts";

export interface MailFields {
  from: string;
  to: string;
  subject: string;
  text: string;
}

// ── Resend (HTTPS API) ──────────────────────────────────────────────────────
export async function resendSend(apiKey: string, m: MailFields): Promise<void> {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ from: m.from, to: [m.to], subject: m.subject, text: m.text }),
  });
  if (!r.ok) throw new Error(`Resend HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
}

// ── Minimal SMTP over implicit TLS (port 465) ───────────────────────────────
function addr(s: string): string {
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim();
}

export async function smtpSend(o: { host: string; port: number; user: string; pass: string } & MailFields): Promise<void> {
  let buf = "";
  let waiter: (() => void) | null = null;
  const wake = () => { const w = waiter; waiter = null; w?.(); };

  const socket = await Bun.connect({
    hostname: o.host,
    port: o.port,
    tls: true, // implicit TLS (465). For 587/STARTTLS use Resend instead.
    socket: {
      data(_s, d) { buf += d.toString(); wake(); },
      error() { wake(); },
      close() { wake(); },
    },
  });

  // Wait for a complete SMTP reply and assert its class matches `code`.
  async function expect(code: number): Promise<void> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      // The final line of a (possibly multi-line) reply is "NNN <text>" with a
      // space after the code; continuation lines use "NNN-<text>".
      const m = buf.match(/(?:^|\r\n)(\d{3}) [^\r\n]*\r\n/);
      if (m && m.index !== undefined) {
        const got = Number(m[1]);
        buf = buf.slice(m.index + m[0].length);
        if (Math.floor(got / 100) !== Math.floor(code / 100)) {
          throw new Error(`SMTP expected ${code}, got ${got}`);
        }
        return;
      }
      if (Date.now() > deadline) throw new Error("SMTP timeout waiting for server");
      await new Promise<void>((res) => { waiter = res; setTimeout(res, 2_000); });
    }
  }
  const send = (line: string) => { socket.write(line + "\r\n"); };
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

  try {
    await expect(220);
    send("EHLO servermind"); await expect(250);
    send("AUTH LOGIN"); await expect(334);
    send(b64(o.user)); await expect(334);
    send(b64(o.pass)); await expect(235);
    send(`MAIL FROM:<${addr(o.from)}>`); await expect(250);
    send(`RCPT TO:<${addr(o.to)}>`); await expect(250);
    send("DATA"); await expect(354);
    // Strip CR/LF from header values so nothing can inject extra headers, even
    // though these values are operator-controlled (hostname / service names).
    const h = (v: string) => v.replace(/[\r\n]+/g, " ").trim();
    const headers = [
      `From: ${h(o.from)}`,
      `To: ${h(o.to)}`,
      `Subject: ${h(o.subject)}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      `Date: ${new Date().toUTCString()}`,
    ].join("\r\n");
    // CRLF line endings + SMTP dot-stuffing for any line starting with ".".
    const body = o.text.replace(/\r?\n/g, "\r\n").replace(/\r\n\./g, "\r\n..");
    socket.write(headers + "\r\n\r\n" + body + "\r\n.\r\n");
    await expect(250);
    send("QUIT");
  } finally {
    try { socket.end(); } catch { /* ignore */ }
  }
}

// ── Config-driven send (used by the watcher) ────────────────────────────────
export async function sendEmail(subject: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const e = config.email;
  if (!e.enabled || !e.to) return { ok: false, error: "email not configured" };
  try {
    if (e.method === "resend") {
      await resendSend(e.resendKey, { from: e.from || "ServerMind <onboarding@resend.dev>", to: e.to, subject, text });
    } else {
      await smtpSend({ host: e.smtp.host, port: e.smtp.port, user: e.smtp.user, pass: e.smtp.pass, from: e.from || e.smtp.user, to: e.to, subject, text });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
