import { test, expect } from "bun:test";
import { FleetRegistry } from "./registry.ts";
import { enrollAgent, revokeAgent, meshTexts, type MeshIdentity, type Applier, type MeshTexts } from "./mesh.ts";
import { generateKeypair } from "./wireguard.ts";

const M = { cidr: "10.99.0.0/24" };

function identity(): MeshIdentity {
  const kp = generateKeypair();
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, listenPort: 51820, endpoint: "203.0.113.5:51820" };
}

// Recording stub: captures the last config it was asked to apply. last() returns
// the SYNC text (what actually hits the live interface); disk() the on-disk form.
function recorder(): { apply: Applier; last: () => string; disk: () => string; calls: () => number } {
  let texts: MeshTexts = { disk: "", sync: "" };
  let calls = 0;
  return {
    apply: async (t) => { texts = t; calls++; return { ok: true }; },
    last: () => texts.sync,
    disk: () => texts.disk,
    calls: () => calls,
  };
}

test("enrollAgent allocates an IP, persists pubkey, applies config, returns agent payload", async () => {
  const reg = new FleetRegistry(":memory:");
  const id = identity();
  const rec = recorder();
  reg.register("a", "vps-a");
  const agentKey = generateKeypair().publicKey;

  const res = await enrollAgent(reg, id, { id: "a", hostname: "vps-a", pubkey: agentKey }, M, rec.apply);
  expect("assignedIp" in res && res.assignedIp).toBe("10.99.0.2");
  expect("controllerPublicKey" in res && res.controllerPublicKey).toBe(id.publicKey);
  expect(reg.meshOf("a")).toEqual({ pubkey: agentKey, ip: "10.99.0.2" });
  expect(rec.last()).toContain(agentKey); // the applied wg0.conf includes the new peer
  reg.close();
});

test("enrollAgent rejects a bad public key without touching the registry", async () => {
  const reg = new FleetRegistry(":memory:");
  const rec = recorder();
  reg.register("a", "vps-a");
  const res = await enrollAgent(reg, identity(), { id: "a", hostname: "vps-a", pubkey: "not-a-key" }, M, rec.apply);
  expect("error" in res).toBe(true);
  expect(reg.meshOf("a")).toBeNull();
  expect(rec.calls()).toBe(0); // never applied
  reg.close();
});

test("re-enroll is idempotent: same IP, rotated key, config reflects the new key", async () => {
  const reg = new FleetRegistry(":memory:");
  const id = identity();
  const rec = recorder();
  reg.register("a", "vps-a");
  const k1 = generateKeypair().publicKey;
  const k2 = generateKeypair().publicKey;

  const r1 = await enrollAgent(reg, id, { id: "a", hostname: "vps-a", pubkey: k1 }, M, rec.apply);
  const r2 = await enrollAgent(reg, id, { id: "a", hostname: "vps-a", pubkey: k2 }, M, rec.apply);
  expect("assignedIp" in r1 && r1.assignedIp).toBe("10.99.0.2");
  expect("assignedIp" in r2 && r2.assignedIp).toBe("10.99.0.2"); // kept its address
  expect(reg.meshOf("a")!.pubkey).toBe(k2); // key rotated
  expect(rec.last()).toContain(k2);
  expect(rec.last()).not.toContain(k1); // old key gone (full re-render)
  reg.close();
});

test("revokeAgent removes the peer and re-applies a config without it", async () => {
  const reg = new FleetRegistry(":memory:");
  const id = identity();
  const rec = recorder();
  const ka = generateKeypair().publicKey;
  const kb = generateKeypair().publicKey;
  reg.register("a", "vps-a"); await enrollAgent(reg, id, { id: "a", hostname: "vps-a", pubkey: ka }, M, rec.apply);
  reg.register("b", "vps-b"); await enrollAgent(reg, id, { id: "b", hostname: "vps-b", pubkey: kb }, M, rec.apply);

  const r = await revokeAgent(reg, id, "a", M, rec.apply);
  expect(r.ok).toBe(true);
  expect(reg.meshPeers().map((p) => p.id)).toEqual(["b"]);
  expect(rec.last()).toContain(kb);
  expect(rec.last()).not.toContain(ka); // revoked key no longer in the config
  reg.close();
});

test("meshTexts reflects exactly the enrolled peers, in both forms", async () => {
  const reg = new FleetRegistry(":memory:");
  const id = identity();
  const rec = recorder();
  const ka = generateKeypair().publicKey;
  reg.register("a", "vps-a"); await enrollAgent(reg, id, { id: "a", hostname: "vps-a", pubkey: ka }, M, rec.apply);

  const { disk, sync } = meshTexts(reg, id, M);
  // disk form (wg-quick) carries Address; sync form (native) must NOT — that was
  // the real `wg syncconf` rejection caught in the live container test.
  expect(disk).toContain("Address = 10.99.0.1/24");
  expect(sync).not.toContain("Address");
  for (const t of [disk, sync]) {
    expect(t).toContain(id.privateKey);
    expect(t).toContain("ListenPort = 51820");
    expect(t).toContain(ka);
    expect(t).toContain("AllowedIPs = 10.99.0.2/32");
  }
  reg.close();
});
