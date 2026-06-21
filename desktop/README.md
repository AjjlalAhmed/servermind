# ServerMind Desktop

A secure desktop client for your ServerMind **controller**. It opens **one
outbound SSH tunnel** to the controller and shows its dashboard in a window —
**no domain, no reverse proxy, no TLS certificate, no manual `ssh -L`.**

The app is a **viewer**, never a controller. Nothing on your servers depends on
it — close the app and ServerMind keeps running, alerting, and monitoring
exactly as before. It adds **zero new network exposure**: the only thing it does
is the outbound SSH connection your README already tells users to make by hand.

## How it works

```
  Desktop app ──one SSH tunnel──► controller 127.0.0.1:5500 (the hub)
        │                               ▲      ▲      ▲
        └─ forwards to localhost:<auto> │      │      │  agents dial OUT
                                     agent1  agent2  agent3
```

1. You add a controller (host + SSH user + key/agent/password).
2. The app opens one SSH connection and forwards a random local port →
   the controller's `127.0.0.1:5500`.
3. It opens that local URL in a dashboard window — the controller's own UI,
   with its **password + TOTP** login and the Fleet tab listing every agent.

You connect to **one** endpoint. Per-agent ports never appear on your side
because agents dial *out* to the controller.

## Run it (dev)

Requires Node 18+.

```bash
cd desktop
npm install
npm start        # builds (tsc) and launches Electron
```

> If `electron --version` prints a Node version instead of an Electron version,
> `ELECTRON_RUN_AS_NODE` is set in your shell. Launch with it cleared:
> `env -u ELECTRON_RUN_AS_NODE npm start`.

## Package installers

```bash
npm run dist     # electron-builder → dmg / nsis / AppImage+deb
```

(App icons aren't included yet — add `build/icon.icns|.ico|.png` before shipping
signed builds.)

## Security model

| Concern | How it's handled |
|---------|------------------|
| Transport | One **outbound** SSH tunnel. Controller stays bound to `127.0.0.1`; no new inbound port, nothing public. |
| Host identity | SSH host key **pinned on first connect (TOFU)**; a changed key aborts the connection. |
| Dashboard auth | Untouched — the controller's own **password + TOTP**. The tunnel reaches the login page; it does **not** auto-authenticate. |
| Secrets at rest | Key passphrase / password encrypted with Electron `safeStorage` (OS-keychain-backed). App state holds **no plaintext secrets**. |
| Dashboard window | Sandboxed, `contextIsolation` on, no Node, no preload — a hostile page can't reach the host. External links open in the OS browser. |
| Blast radius | The app is a viewer. Delete it and no server changes. The controller stays the single crown jewel to isolate, per ARCHITECTURE.md. |

## Layout

```
src/main/      Electron main process
  index.ts       app lifecycle + window
  store.ts       controller list + safeStorage-encrypted secrets
  tunnel.ts      ssh2 SSH connection + local port-forward (the tunnel)
  ipc.ts         IPC handlers + dashboard window
src/preload/   contextBridge API (the only renderer surface)
src/renderer/  control-panel UI (vanilla TS/HTML/CSS, no framework)
```

## Status / roadmap

- **Now (v0.1):** add controllers, auto SSH tunnel with reconnect, host-key
  pinning, encrypted secrets, dashboard window.
- **Next:** in-app "Add server" that runs the agent install command over SSH;
  fleet status surfaced in the app; desktop notifications from alerts.
- **Later:** port to Tauri for a ~10 MB signed binary (the tunnel logic moves to
  Rust `russh`; the dashboard webview stays the same).
