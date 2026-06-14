// Controller-side mesh manager — the stateful glue between the HTTP/UI layer and
// the pure mesh orchestration. Holds the controller's WG identity + applier and
// the registry, and exposes the three things the app needs: bring the interface
// up on boot, enroll an agent, and re-apply after a removal.
//
// Instantiated once on startup (index.ts) only when config.mesh.enabled.

import { config } from "../config.ts";
import type { FleetRegistry } from "./registry.ts";
import {
  loadOrCreateIdentity,
  fileApplier,
  bringUpInterface,
  meshTexts,
  enrollAgent,
  type MeshIdentity,
  type EnrollInput,
  type EnrollResult,
  type Applier,
} from "./mesh.ts";
import type { MeshConfig } from "./wireguard.ts";

const IDENTITY_PATH = new URL("../../data/wg-controller.json", import.meta.url).pathname;

export class MeshController {
  private id: MeshIdentity;
  private apply: Applier;
  private confPath: string;
  private syncPath: string;
  private iface: string;

  constructor(private reg: FleetRegistry) {
    const m = config.mesh;
    this.iface = m.iface;
    this.confPath = `${m.dir}/${m.iface}.conf`;
    this.syncPath = `${m.dir}/${m.iface}.sync`;
    this.id = loadOrCreateIdentity(IDENTITY_PATH, { listenPort: m.listenPort, endpoint: m.endpoint });
    this.apply = fileApplier(this.confPath, this.syncPath, m.iface);
  }

  private get meshConfig(): MeshConfig {
    return { cidr: config.mesh.cidr };
  }

  get publicKey(): string {
    return this.id.publicKey;
  }
  get endpoint(): string {
    return this.id.endpoint;
  }

  // Bring wg0 up from current registry state. Called once on boot.
  start(): Promise<{ ok: boolean; error?: string }> {
    return bringUpInterface(this.iface, this.confPath, this.syncPath, meshTexts(this.reg, this.id, this.meshConfig));
  }

  // Enroll (or idempotently re-enroll) an agent and return what it needs to build
  // its own wg config. The agent's PRIVATE key never reaches us — only its pubkey.
  enroll(input: EnrollInput): Promise<EnrollResult | { error: string }> {
    return enrollAgent(this.reg, this.id, input, this.meshConfig, this.apply);
  }

  // Re-render + reload wg0 from current registry state — used after an agent is
  // removed so its peer truly drops off the live interface.
  reapply(): Promise<{ ok: boolean; error?: string }> {
    return this.apply(meshTexts(this.reg, this.id, this.meshConfig));
  }
}
