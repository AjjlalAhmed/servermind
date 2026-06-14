// Controller-side registry of agents and their latest status.
//
// Persisted with Bun's built-in SQLite (no dependency): the server list +
// last-seen survive restarts. Latest status snapshots are kept in memory
// (they refresh every ~15s, so there's no need to persist them).

import { Database } from "bun:sqlite";
import type { StatusSnapshot } from "../status.ts";

const ONLINE_MS = 45_000; // an agent is "online" if seen within this window

export interface FleetServer {
  id: string;
  hostname: string;
  online: boolean;
  lastSeen: number; // epoch ms
  status: StatusSnapshot | null;
}

export class FleetRegistry {
  private db: Database;
  private status = new Map<string, StatusSnapshot>();
  private lastSeen = new Map<string, number>();

  constructor(path = ":memory:") {
    this.db = new Database(path, { create: true });
    this.db.run("CREATE TABLE IF NOT EXISTS servers (id TEXT PRIMARY KEY, hostname TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL)");
    // Migration: add the WireGuard mesh columns to pre-existing controller DBs.
    // We store only the agent's PUBLIC key + its assigned mesh IP — never a
    // private key (those are generated on the agent and never leave it).
    const cols = (this.db.query("PRAGMA table_info(servers)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes("wg_pubkey")) this.db.run("ALTER TABLE servers ADD COLUMN wg_pubkey TEXT");
    if (!cols.includes("wg_ip")) this.db.run("ALTER TABLE servers ADD COLUMN wg_ip TEXT");
    for (const row of this.db.query("SELECT id, last_seen FROM servers").all() as Array<{ id: string; last_seen: number }>) {
      this.lastSeen.set(row.id, row.last_seen);
    }
  }

  register(id: string, hostname: string, now = Date.now()): void {
    this.db.run(
      "INSERT INTO servers (id, hostname, first_seen, last_seen) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET hostname=excluded.hostname, last_seen=excluded.last_seen",
      [id, hostname, now, now],
    );
    this.lastSeen.set(id, now);
  }

  setStatus(id: string, snapshot: StatusSnapshot, now = Date.now()): void {
    this.status.set(id, snapshot);
    this.lastSeen.set(id, now);
    this.db.run("UPDATE servers SET last_seen=? WHERE id=?", [now, id]);
  }

  list(now = Date.now()): FleetServer[] {
    const rows = this.db.query("SELECT id, hostname FROM servers ORDER BY hostname").all() as Array<{ id: string; hostname: string }>;
    return rows.map((r) => {
      const seen = this.lastSeen.get(r.id) ?? 0;
      return { id: r.id, hostname: r.hostname, lastSeen: seen, online: now - seen < ONLINE_MS, status: this.status.get(r.id) ?? null };
    });
  }

  // The hostname previously recorded for this agent id, or null if unseen.
  // Used by the hub to reject a hello that reuses an id with a new hostname.
  hostnameOf(id: string): string | null {
    const row = this.db.query("SELECT hostname FROM servers WHERE id=?").get(id) as { hostname?: string } | null;
    return row?.hostname ?? null;
  }

  // ── WireGuard mesh ──────────────────────────────────────────────────────────
  // Record an agent's public key + assigned mesh IP (storage only; IP allocation
  // and config rendering live in mesh.ts).
  setMesh(id: string, pubkey: string, ip: string): void {
    this.db.run("UPDATE servers SET wg_pubkey=?, wg_ip=? WHERE id=?", [pubkey, ip, id]);
  }

  // Existing mesh assignment for an agent, or null. Used for IDEMPOTENT
  // re-enrollment: a box that reinstalls keeps its IP instead of grabbing a new
  // one, so the mesh converges across restarts rather than leaking addresses.
  meshOf(id: string): { pubkey: string; ip: string } | null {
    const row = this.db.query("SELECT wg_pubkey, wg_ip FROM servers WHERE id=?").get(id) as
      | { wg_pubkey?: string; wg_ip?: string }
      | null;
    return row?.wg_pubkey && row?.wg_ip ? { pubkey: row.wg_pubkey, ip: row.wg_ip } : null;
  }

  // Every mesh IP currently handed out — feeds allocateIp() so it never collides.
  usedIps(): string[] {
    return (this.db.query("SELECT wg_ip FROM servers WHERE wg_ip IS NOT NULL").all() as Array<{ wg_ip: string }>).map((r) => r.wg_ip);
  }

  // Enrolled peers (pubkey + IP set) — the source of truth the controller's
  // wg0.conf is fully re-rendered from on every change.
  meshPeers(): Array<{ id: string; hostname: string; pubkey: string; ip: string }> {
    return this.db
      .query("SELECT id, hostname, wg_pubkey AS pubkey, wg_ip AS ip FROM servers WHERE wg_pubkey IS NOT NULL AND wg_ip IS NOT NULL ORDER BY wg_ip")
      .all() as Array<{ id: string; hostname: string; pubkey: string; ip: string }>;
  }

  remove(id: string): void {
    this.db.run("DELETE FROM servers WHERE id=?", [id]);
    this.status.delete(id);
    this.lastSeen.delete(id);
  }

  close(): void {
    this.db.close();
  }
}
