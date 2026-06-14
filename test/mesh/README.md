# Mesh container scenarios

Integration tests for the self-hosted WireGuard mesh, run inside Docker against
**real** WireGuard tooling and **real** distros — they validate things unit tests
can't (kernel interface, `wg`/`wg-quick` parsing, cross-distro packaging, the
sudoers containment). The pure logic is unit-tested next to the source
(`src/fleet/*.test.ts`); this folder holds everything that needs a Linux box.

## Run

```bash
test/mesh/run.sh          # all scenarios across ubuntu/debian/fedora/alpine
test/mesh/run.sh quick    # ubuntu + alpine only (fast)
```

Requires Docker. The interface scenarios run with `--cap-add=NET_ADMIN
--cap-add=SYS_MODULE` so a live `wg0` can be created (the host kernel must have
WireGuard — Docker Desktop's kernel does).

## Scenarios

| Script | Proves |
|--------|--------|
| `scenario-keygen-compat.sh` | our Bun X25519 `generateKeypair()` is **byte-identical** to `wg pubkey` — the keys actually work in WireGuard |
| `scenario-config-apply.sh` | a config rendered by the real module is accepted by `wg-quick up` (disk form) **and** `wg syncconf` (stripped form); live peer add/remove works with no interface bounce |
| `scenario-controller-setup.sh <image>` | `scripts/setup-mesh-controller.sh` installs prereqs + creates the service user on that distro, the app can do its job via the scoped sudoers rule, **and** that rule blocks shells / arbitrary files / other interfaces |

## Helpers (not scenarios)

- `render-config.ts` / `keygen-print.ts` — tiny entrypoints that call the real
  `src/fleet/wireguard.ts` so the shell scenarios exercise the actual code path.

## Why a folder

App code lives in `src/`. Everything here is test/infra: shell harnesses, the
container scenarios, and these notes. Keeping it out of `src/` keeps the shipped
app lean (the installer already strips non-runtime files on deploy).
