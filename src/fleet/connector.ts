// Agent-side connector: dials OUT to the controller hub, enrolls, then pushes a
// status snapshot every interval. Reconnects on drop. No inbound ports are
// opened on the agent's host.

import { getStatusSnapshot } from "../status.ts";
import { localAgent } from "../agent.ts";
import { advertisedCustomTools } from "../tools/custom.ts";
import { helloFrame, statusFrame, resultFrame, parseControllerMessage } from "./protocol.ts";

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
      // Advertise this box's own custom tools (names only) so the controller can
      // offer them to the AI when an operator manages this server. The agent
      // still re-validates and runs them locally.
      const tools = advertisedCustomTools();
      ws!.send(helloFrame({ token: opts.token, agentId: opts.agentId, hostname: opts.hostname, version: opts.version, tools }));
      if (tools.length) log(`advertised ${tools.length} custom tool(s): ${tools.map((t) => t.name).join(", ")}`);
      void pushStatus();
      timer = setInterval(() => void pushStatus(), intervalMs);
    });

    // Controller commands. The agent runs them through its OWN localAgent, so
    // the read-only allowlist + arm switch are enforced here — never bypassed.
    ws.addEventListener("message", (ev) => {
      const cmd = parseControllerMessage(typeof ev.data === "string" ? ev.data : String(ev.data));
      if (!cmd) return;
      if (cmd.type === "arm") { localAgent.setArmed(cmd.on); return; }
      if (cmd.type === "invoke") {
        // allowMutations comes from THIS box's arm state — not the controller's word.
        localAgent.invoke(cmd.name, cmd.input, localAgent.isArmed())
          .then((r) => ws?.readyState === WebSocket.OPEN && ws.send(resultFrame(cmd.reqId, r.content, r.isError)))
          .catch((e) => ws?.readyState === WebSocket.OPEN && ws.send(resultFrame(cmd.reqId, `tool error: ${(e as Error).message}`, true)));
      }
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
