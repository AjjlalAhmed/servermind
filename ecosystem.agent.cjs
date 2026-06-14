// PM2 process definition for a ServerMind AGENT (fleet member).
//   pm2 start ecosystem.agent.cjs
//   pm2 save && pm2 startup
//
// This runs the agent core (src/agent-main.ts): no web UI, no auth, no AI. It
// dials OUT to the controller (SERVERMIND_CONTROLLER) and reports status; the
// read-only allowlist + arm switch stay enforced locally on this box.
//
// .cjs (CommonJS) on purpose — package.json sets "type": "module", so a plain
// .js here would be parsed as ESM and PM2's require() would fail.
//
// Config (SERVERMIND_CONTROLLER, FLEET_JOIN_TOKEN, SERVERMIND_AGENT_ID, …) is
// read by Bun from this directory's .env — agent.sh writes it there.
module.exports = {
  apps: [
    {
      name: "servermind-agent",
      interpreter: "bun",
      script: "src/agent-main.ts",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      max_memory_restart: "150M",
      env: {
        NODE_ENV: "production",
      },
      out_file: "./logs/servermind-agent-out.log",
      error_file: "./logs/servermind-agent-err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
