// Redis health probe over a raw TCP socket (RESP protocol). No client lib
// needed — we send PING / INFO and parse the replies ourselves.

import { config } from "../config.ts";

interface RedisProbeResult {
  ok: boolean;
  ping: string | null;
  connected: boolean;
  version?: string;
  usedMemoryHuman?: string;
  connectedClients?: string;
  uptimeSeconds?: string;
  raw?: string;
  error?: string;
}

function send(host: string, port: number, payload: string, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      try {
        socket?.end();
      } catch {}
      reject(new Error("redis connection timed out"));
    }, timeoutMs);

    let socket: ReturnType<typeof Bun.connect> extends Promise<infer S> ? S : any;

    Bun.connect({
      hostname: host,
      port,
      socket: {
        open(sock) {
          socket = sock;
          sock.write(payload);
        },
        data(sock, data) {
          buf += data.toString();
          // INFO ends with the bulk string; PING is a simple +PONG. Give a beat
          // for the full INFO payload, then close.
          if (buf.includes("+PONG") && !payload.includes("INFO")) {
            clearTimeout(timer);
            sock.end();
            resolve(buf);
          }
        },
        close() {
          clearTimeout(timer);
          resolve(buf);
        },
        error(_sock, err) {
          clearTimeout(timer);
          reject(err);
        },
      },
    }).catch((err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function field(info: string, key: string): string | undefined {
  const m = info.match(new RegExp(`^${key}:(.*)$`, "m"));
  return m ? m[1]!.trim() : undefined;
}

export async function redisProbe(): Promise<RedisProbeResult> {
  const { host, port } = config.redis;
  try {
    // Inline RESP command pipeline: PING then INFO.
    const reply = await send(host, port, "PING\r\nINFO\r\n", 4000);
    const connected = reply.includes("+PONG");
    return {
      ok: connected,
      connected,
      ping: connected ? "PONG" : null,
      version: field(reply, "redis_version"),
      usedMemoryHuman: field(reply, "used_memory_human"),
      connectedClients: field(reply, "connected_clients"),
      uptimeSeconds: field(reply, "uptime_in_seconds"),
      raw: reply.length > 4000 ? reply.slice(0, 4000) : reply,
    };
  } catch (err) {
    return {
      ok: false,
      connected: false,
      ping: null,
      error: `${host}:${port} — ${(err as Error).message}`,
    };
  }
}
