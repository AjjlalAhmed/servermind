// Agent-side connector: dials OUT to the controller hub, enrolls, then pushes a
// status snapshot every interval. Reconnects on drop. No inbound ports are
// opened on the agent's host.

import { getStatusSnapshot } from "../status.ts";
import { helloFrame, statusFrame } from "./protocol.ts";

export interface AgentOptions {
  controllerUrl: string; // ws(s)://controller/fleet/agent
  token: string;
  agentId: string;
  hostname: string;
  version?: string;
  intervalMs?: number;
  log?: (msg: string) => void;
}

export function startAgentConnector(opts: AgentOptions): { stop: () => void } {
  const log = opts.log ?? (() => {});
  const intervalMs = opts.intervalMs ?? 15_000;
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const pushStatus = async () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(statusFrame(await getStatusSnapshot()));
    } catch (e) {
      log(`status push failed: ${(e as Error).message}`);
    }
  };

  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(opts.controllerUrl);

    ws.addEventListener("open", () => {
      log(`connected to ${opts.controllerUrl}`);
      ws!.send(helloFrame({ token: opts.token, agentId: opts.agentId, hostname: opts.hostname, version: opts.version }));
      void pushStatus();
      timer = setInterval(() => void pushStatus(), intervalMs);
    });

    const cleanup = () => { if (timer) { clearInterval(timer); timer = null; } };
    ws.addEventListener("close", () => {
      cleanup();
      if (!stopped) { log("disconnected — retrying in 5s"); setTimeout(connect, 5_000); }
    });
    ws.addEventListener("error", () => { try { ws?.close(); } catch { /* ignore */ } });
  };

  connect();
  return {
    stop() { stopped = true; if (timer) clearInterval(timer); try { ws?.close(); } catch { /* ignore */ } },
  };
}
