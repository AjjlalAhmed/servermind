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

  remove(id: string): void {
    this.db.run("DELETE FROM servers WHERE id=?", [id]);
    this.status.delete(id);
    this.lastSeen.delete(id);
  }

  close(): void {
    this.db.close();
  }
}
