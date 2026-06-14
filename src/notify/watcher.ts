// Background watcher: every minute it takes a status snapshot, emails alerts
// when thresholds are crossed (with a per-alert cooldown so it can't spam), and
// sends one daily digest at the configured hour. In-memory state only — a
// restart simply re-arms everything, which is fine.

import { config, emailConfigured } from "../config.ts";
import { getStatusSnapshot } from "../status.ts";
import { sendEmail } from "./email.ts";
import { evaluateAlerts, buildDigest, type Alert } from "./report.ts";
import { evaluateCertAlerts } from "./cert.ts";

const lastAlertAt = new Map<string, number>(); // alert key → epoch ms
let lastDigestDay = ""; // YYYY-MM-DD of the last digest sent
let lastCertCheck = 0; // epoch ms of the last TLS-cert check

const CHECK_INTERVAL_MS = 60_000;
const FIRST_CHECK_DELAY_MS = 30_000; // let the server settle before the first run
const CERT_CHECK_INTERVAL_MS = 6 * 3_600_000; // certs change slowly — check every 6h

async function tick(): Promise<void> {
  try {
    const snap = await getStatusSnapshot();

    // ── alerts (cooldown-gated) ──
    const cooldownMs = Math.max(1, config.alerts.cooldownMin) * 60_000;
    const now = Date.now();

    const alerts: Alert[] = evaluateAlerts(snap);
    // TLS-cert checks do a handshake, so run them on a slow throttle, not every minute.
    if (config.alerts.certDomains.length && now - lastCertCheck >= CERT_CHECK_INTERVAL_MS) {
      lastCertCheck = now;
      alerts.push(...(await evaluateCertAlerts()));
    }

    for (const a of alerts) {
      if (now - (lastAlertAt.get(a.key) ?? 0) < cooldownMs) continue;
      const r = await sendEmail(a.subject, `${a.body}\n\n— ServerMind`);
      if (r.ok) lastAlertAt.set(a.key, now);
      else console.error("[watcher] alert email failed:", r.error);
    }

    // ── daily digest (once per day at the configured hour, server local time) ──
    if (config.alerts.digestHour >= 0) {
      const d = new Date();
      const day = d.toISOString().slice(0, 10);
      if (d.getHours() === config.alerts.digestHour && lastDigestDay !== day) {
        lastDigestDay = day;
        const digest = buildDigest(snap);
        const r = await sendEmail(digest.subject, digest.body);
        if (!r.ok) console.error("[watcher] digest email failed:", r.error);
      }
    }
  } catch (e) {
    console.error("[watcher] tick error:", (e as Error).message);
  }
}

export function startWatcher(): void {
  if (!emailConfigured()) return;
  setTimeout(tick, FIRST_CHECK_DELAY_MS);
  setInterval(tick, CHECK_INTERVAL_MS);
  const digest = config.alerts.digestHour >= 0 ? `${String(config.alerts.digestHour).padStart(2, "0")}:00` : "off";
  console.log(`  Email: ${config.email.to}  |  alerts: disk≥${config.alerts.diskPct}% mem≥${config.alerts.memPct}%, daily report ${digest}`);
}
