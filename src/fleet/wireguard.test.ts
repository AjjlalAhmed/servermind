import { test, expect } from "bun:test";
import {
  generateKeypair,
  isWgKey,
  allocateIp,
  controllerIp,
  prefixOf,
  renderAgentConfig,
  renderControllerPeer,
  renderControllerConfig,
  DEFAULT_MESH,
} from "./wireguard.ts";

test("generateKeypair produces distinct, WireGuard-format keys", () => {
  const a = generateKeypair();
  const b = generateKeypair();
  expect(isWgKey(a.privateKey)).toBe(true);
  expect(isWgKey(a.publicKey)).toBe(true);
  expect(a.privateKey).not.toBe(a.publicKey);
  expect(a.publicKey).not.toBe(b.publicKey); // each call is fresh
});

test("isWgKey rejects non-keys", () => {
  expect(isWgKey("")).toBe(false);
  expect(isWgKey("nope")).toBe(false);
  expect(isWgKey("z2rLNqOb9OzPtop87Ksj9UCpL4+UkSKnx212nwZke4")).toBe(false); // missing pad
  expect(isWgKey(123)).toBe(false);
});

test("allocateIp skips controller, hands out lowest free, dedupes", () => {
  expect(allocateIp([])).toBe("10.99.0.2"); // .1 is the controller
  expect(allocateIp(["10.99.0.2"])).toBe("10.99.0.3");
  expect(allocateIp(["10.99.0.3", "10.99.0.2"])).toBe("10.99.0.4");
  expect(allocateIp([])).not.toBe(controllerIp());
});

test("allocateIp returns null when the /24 is exhausted", () => {
  const used: string[] = [];
  for (let h = 2; h <= 254; h++) used.push(`10.99.0.${h}`);
  expect(allocateIp(used)).toBeNull();
});

test("configurable CIDR: a /16 lifts the ~253-agent cap and crosses octets", () => {
  const m = { cidr: "10.99.0.0/16" };
  expect(prefixOf(m)).toBe(16);
  expect(controllerIp(m)).toBe("10.99.0.1");
  // fill the rest of .0.x so allocation must roll into .1.x
  const used: string[] = [];
  for (let h = 2; h <= 254; h++) used.push(`10.99.0.${h}`);
  used.push("10.99.0.255"); // .255 is a normal host inside a /16
  expect(allocateIp(used, m)).toBe("10.99.1.0");
});

test("renderAgentConfig: tunnel carries only the mesh subnet (not a default route)", () => {
  const cfg = renderAgentConfig({
    agentPrivateKey: "PRIV",
    agentIp: "10.99.0.7",
    controllerPublicKey: "CTRLPUB",
    controllerEndpoint: "203.0.113.5:51820",
  });
  expect(cfg).toContain("Address = 10.99.0.7/32");
  expect(cfg).toContain("Endpoint = 203.0.113.5:51820");
  expect(cfg).toContain("AllowedIPs = 10.99.0.0/24"); // NOT 0.0.0.0/0 — never a default gw
  expect(cfg).not.toContain("0.0.0.0/0");
  expect(cfg).toContain("PersistentKeepalive = 25");
});

test("renderControllerPeer pins one /32 to one key", () => {
  const block = renderControllerPeer({ publicKey: "AGENTPUB", agentIp: "10.99.0.7", hostname: "vps-3" });
  expect(block).toContain("# vps-3");
  expect(block).toContain("PublicKey = AGENTPUB");
  expect(block).toContain("AllowedIPs = 10.99.0.7/32"); // single host — no peer can claim another's ip
});

test("renderControllerConfig renders the WHOLE file from the peer list (idempotent)", () => {
  const iface = { privateKey: "CPRIV", listenPort: 51820 };
  const peers = [
    { publicKey: "PUB2", agentIp: "10.99.0.2", hostname: "vps-2" },
    { publicKey: "PUB3", agentIp: "10.99.0.3", hostname: "vps-3" },
  ];
  const full = renderControllerConfig(iface, peers);
  expect(full).toContain(`Address = ${controllerIp(DEFAULT_MESH)}/24`);
  expect(full).toContain("ListenPort = 51820");
  expect(full).toContain("PrivateKey = CPRIV");
  expect(full).toContain("PublicKey = PUB2");
  expect(full).toContain("PublicKey = PUB3");
  // re-rendering WITHOUT vps-3 makes it truly disappear (not append-only)
  const without = renderControllerConfig(iface, peers.slice(0, 1));
  expect(without).toContain("PUB2");
  expect(without).not.toContain("PUB3");
});

test("forSync render omits Address (native format `wg syncconf` accepts)", () => {
  const iface = { privateKey: "CPRIV", listenPort: 51820 };
  const peers = [{ publicKey: "PUB2", agentIp: "10.99.0.2", hostname: "vps-2" }];
  const sync = renderControllerConfig(iface, peers, { forSync: true });
  expect(sync).not.toContain("Address"); // the line `wg syncconf` rejected
  expect(sync).toContain("ListenPort = 51820");
  expect(sync).toContain("PrivateKey = CPRIV");
  expect(sync).toContain("PublicKey = PUB2");
  expect(sync).toContain("AllowedIPs = 10.99.0.2/32");
});
