# Quickstart

## Prerequisites

- **Bun** `>=1.3.14`
- **Node** `>=22 <25` for OmniRoute specifically (its `package.json` `engines`
  field enforces this). If your system Node is outside that range — e.g.
  macOS with Homebrew's default `node` on 25.x — install a matching version
  as a *second*, non-global toolchain rather than downgrading system Node:

  ```sh
  brew install node@24   # keg-only; never symlinked into PATH by default
  ```

  Then point every command below at it with `NODE_BIN_DIR` (Makefile) or
  `MYWAYAI_NODE_BIN_DIR` (the `mywayai` CLI directly) — both just prepend the
  given directory to `PATH` for the one spawned `npm`/`node` call, leaving
  your global `node` untouched:

  ```sh
  make build-omniroute NODE_BIN_DIR=/opt/homebrew/opt/node@24/bin
  MYWAYAI_NODE_BIN_DIR=/opt/homebrew/opt/node@24/bin mywayai up
  ```

## First run

```sh
make install           # bun install at the workspace root
make build-omniroute   # npm ci + npm run build in vendor/omniroute (~10 min cold)
make dev                # boots OmniRoute, seeds a mock combo, launches omp
```

`make dev` is a thin wrapper around the `mywayai` CLI:

```sh
bun run --cwd integrations/launcher src/cli.ts up --seed-mock
```

On first boot this:

1. Builds `vendor/omniroute` if `.build/next` is missing (skipped if already built).
2. Starts the vendored OmniRoute server on port `20128` (override with `--port`
   or `OMNIROUTE_PORT`).
3. Provisions an OmniRoute API key (see **Key provisioning** below).
4. Seeds a mock combo (`test-combo`, routing to `infra/mock-provider`) — only
   with `--seed-mock`; omit it once you've configured real providers.
5. Writes omp's `~/.omp/agent/models.yml` `providers.omniroute` block.
6. Installs the `omp-omniroute-extension` into `~/.omp/agent/extensions/`.
7. Execs the pinned `omp` binary, forwarding any trailing args after `--`.

## Everyday commands

```sh
mywayai up [--seed-mock] [--port <n>] [-- <omp args>]
mywayai down                 # stop the OmniRoute server
mywayai status                # OmniRoute + pidfile state
mywayai logs [--tail <n>]     # tail vendor/omniroute's log file
mywayai sync                  # pull both upstreams (see docs/upstream-sync.md)
```

## Key provisioning

OmniRoute ships `INITIAL_PASSWORD=CHANGEME` in `.env.example` (copied to
`vendor/omniroute/.env` by its own `npm ci` postinstall), so dashboard auth is
required from the very first boot. `provisionKey()` therefore:

1. Tries an unauthenticated key mint first (fast path — succeeds only if you
   deliberately run OmniRoute with no password configured at all).
2. Otherwise logs in with the `.env` password (falling back to `CHANGEME`),
   then mints a key using that session.
3. If both fail, throws with the exact fix: set `MYWAYAI_OMNIROUTE_KEY=<key>`
   to a key you create manually from the dashboard
   (`http://localhost:20128`), then re-run.

**Known issue:** step 2's authenticated mint has been observed to hang for
the full bootstrap timeout in some environments — a confirmed OmniRoute
server-side issue, not specific to this bridge's HTTP client (reproduced
identically via curl, Bun's `fetch`, and a real browser; see
`docs/architecture.md`'s "Known issues" section for the full writeup).
`provisionKey()` already retries once with backoff; if it still fails, use
the `MYWAYAI_OMNIROUTE_KEY` manual path above.

## Using OmniRoute from omp

Once `mywayai up` completes, models are available as `omniroute/<combo-name>`
(e.g. `omniroute/test-combo` from the mock seed). Map an omp role to a combo:

```sh
/omni role default test-combo
```

or from the shell before starting a session:

```sh
mywayai up -- --model omniroute/test-combo -p "say hi" --no-session
```

Inside an omp session, `/omni` exposes OmniRoute's admin surface — combos,
quota, usage, fallback chains, provider health, live session counts, role
mapping, and key rotation. Run `/omni` with no arguments for the full command
list.

## Remote access (optional)

This gives a phone-reachable list of your active omp sessions, gated by
Tailscale device approval plus an OmniRoute-login-gated dashboard. Design
rationale and threat model live in a local ADR (`docs/adr/`, gitignored —
working design notes, not shipped in the repo) if you have one checked out;
the steps below are self-contained without it.

### Step 1 — set `tools.approvalMode` explicitly

Do this before registering any remote session:

```yaml
tools:
  approvalMode: <explicit-non-yolo-mode>
```

A full `/collab` link is an RCE-capable credential once you override the
extension's warning with `--force`, because omp defaults tool approval with
`settings?.get("tools.approvalMode") ?? "yolo"` when the setting is missing.

### Step 2 — opt in per session

Inside each omp session you want on the dashboard:

```text
/collab
```

`/collab` is the built-in omp command. It prints a join link and QR code. Copy
the printed **full** link, not the `/collab view` read-only variant, then run in
the same session:

```text
/remote register <link>
```

Use `/remote status` to inspect the registration and `/remote unregister` to
remove it. This is intentionally a two-step flow: omp's extension API cannot
invoke `/collab` programmatically, so `/remote` cannot auto-start sharing for
you.

### Step 3 — run the dashboard

For foreground testing:

```sh
mywayai dashboard up [--host <tailscale-ip>] [--port <n>]
```

To install a login item/user service that survives reboot:

```sh
mywayai dashboard install
```

`install` writes the `launchd` or `systemd --user` unit and prints the exact
load/enable command. The CLI does not auto-load it for you.

### Step 4 — approve Tailscale devices

Turn on **Device Approval** in the Tailscale admin console:

https://login.tailscale.com/admin/settings/device-management

Then manually approve each device that should reach the dashboard, including
your phone and the computer running omp. This is one-time per device and is not
automatable from this repo.

### Mobile note

Tailscale on iOS/Android can show "offline" after the phone idles because the
OS suspends background networking aggressively. Foreground the Tailscale app or
the dashboard to reconnect; this is normal, not a mywayai bug.

### Security note

Possession of a registered `/collab` link is equivalent to a working credential
on that machine. Treat `~/.mywayai/sessions.json` like an API key file; it
contains the full links and ships with `chmod 0600`.

The dashboard's own login (`dash_session`) is a self-contained signed cookie,
not a server-side session — `/logout` only clears the browser's copy, it
doesn't revoke the token itself. If a device/cookie is lost or compromised,
the real kill switch is: delete `~/.mywayai/dashboard.secret` and restart
`mywayai dashboard up` (or restart the installed unit) — every outstanding
`dash_session` cookie, everywhere, is instantly invalid, since they're all
signed against that one secret. Revoking the device's Tailscale approval is
the other half of losing a device; do both.

## Running the mock provider standalone

```sh
bun infra/mock-provider/server.ts        # listens on MOCK_PORT (default 9999)
```

Or via Docker (`infra/docker-compose.yml` brings up OmniRoute + the mock
provider together — see that file's comments for port/env overrides).

## Tests

```sh
make e2e   # boots real OmniRoute + the mock provider, verifies a full
           # request round-trip (bridge -> OmniRoute -> combo -> mock provider)
```
