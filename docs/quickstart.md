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
