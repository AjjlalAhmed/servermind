// Test helper: render a controller wg0.conf using the REAL wireguard.ts module,
// so the container scenarios validate the actual code path (not a hand-written
// config). Prints the disk (wg-quick) form, or the stripped sync form with `sync`.
//
//   bun test/mesh/render-config.ts        → disk form (with Address)
//   bun test/mesh/render-config.ts sync   → native form (for `wg syncconf`)
import { generateKeypair, renderControllerConfig } from "../../src/fleet/wireguard.ts";

const ctrl = generateKeypair();
const a1 = generateKeypair();
const a2 = generateKeypair();
const iface = { privateKey: ctrl.privateKey, listenPort: 51820 };
const peers = [
  { publicKey: a1.publicKey, agentIp: "10.99.0.2", hostname: "vps-2" },
  { publicKey: a2.publicKey, agentIp: "10.99.0.3", hostname: "vps-3" },
];
console.log(renderControllerConfig(iface, peers, { forSync: process.argv[2] === "sync" }));
