// TLS certificate expiry checks. Opens a TLS handshake to each configured
// domain (your SERVERMIND_DOMAIN by default), reads the certificate's notAfter
// date, and raises an alert when it's within the threshold. A failed check is
// never treated as an alert (it could be transient) — just logged.

import tls from "node:tls";
import { getAlerts } from "../settings.ts";
import type { Alert } from "./report.ts";

export function certDaysLeft(host: string, port = 443): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      const validTo = cert && (cert as { valid_to?: string }).valid_to;
      if (!validTo) return reject(new Error("no certificate returned"));
      const ms = new Date(validTo).getTime() - Date.now();
      resolve(Math.floor(ms / 86_400_000));
    });
    socket.setTimeout(8_000, () => { socket.destroy(); reject(new Error("tls timeout")); });
    socket.on("error", reject);
  });
}

export async function evaluateCertAlerts(): Promise<Alert[]> {
  const out: Alert[] = [];
  for (const host of getAlerts().certDomains) {
    if (!host) continue;
    try {
      const days = await certDaysLeft(host);
      if (days <= getAlerts().certDays) {
        out.push({
          key: `cert:${host}`,
          subject: days < 0
            ? `🔐 ${host}: TLS certificate EXPIRED`
            : `🔐 ${host}: TLS certificate expires in ${days} day(s)`,
          body: days < 0
            ? `The TLS certificate for ${host} expired ${-days} day(s) ago — renew it now.`
            : `The TLS certificate for ${host} expires in ${days} day(s) (alert threshold ${getAlerts().certDays}).`,
        });
      }
    } catch (e) {
      console.error(`[cert] check failed for ${host}:`, (e as Error).message);
    }
  }
  return out;
}
