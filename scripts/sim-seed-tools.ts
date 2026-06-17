// Sim-only: seed a box's custom tools from a JSON file before the app starts,
// so the fleet simulation is turnkey and reproducible (survives rebuilds, no
// manual seeding). Reads the manifest array at $SIM_SEED_FILE and writes it via
// the normal settings path (encrypting db passwords with $SETTINGS_KEY). No-op
// when SIM_SEED_FILE is unset or missing. Never blocks boot. NOT for production.

import { readFileSync } from "node:fs";
import { updateSettings } from "../src/settings.ts";

const file = process.env.SIM_SEED_FILE?.trim();
if (!file) {
  console.log("[sim-seed] SIM_SEED_FILE not set — skipping");
  process.exit(0);
}

let tools: unknown;
try {
  tools = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  console.error(`[sim-seed] could not read ${file}: ${(e as Error).message}`);
  process.exit(0); // never block startup
}

const r = await updateSettings({ customTools: tools });
const n = Array.isArray(tools) ? tools.length : 0;
console.log(r.ok ? `[sim-seed] seeded ${n} tool(s) from ${file}` : `[sim-seed] FAILED: ${r.error}`);
process.exit(0);
