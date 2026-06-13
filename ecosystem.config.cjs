// PM2 process definition for ServerMind.
//   pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup
//
// NOTE: this is a .cjs (CommonJS) file on purpose — package.json sets
// "type": "module", so a plain .js here would be parsed as ESM and PM2's
// require() would fail with ERR_REQUIRE_ESM.
//
// IMPORTANT: start PM2 as the user that's logged into Claude Code (e.g.
// claudeuser) so the spawned `claude -p` inherits the subscription login, and
// do NOT add ANTHROPIC_API_KEY to env below (that would switch to paid API).
module.exports = {
  apps: [
    {
      name: "servermind",
      // Run via Bun. `which bun` -> use that absolute path if pm2 can't find it.
      interpreter: "bun",
      script: "src/index.ts",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
      },
      // ServerMind reads its own .env via Bun; PM2 doesn't need to inject secrets.
      out_file: "./logs/servermind-out.log",
      error_file: "./logs/servermind-err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
