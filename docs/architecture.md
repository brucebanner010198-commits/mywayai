# Architecture

## Overview

This repo integrates two independently-released upstream projects:

- **OmniRoute** (`vendor/omniroute`, from `diegosouzapw/OmniRoute`) — a
  self-hosted, Next.js-based LLM gateway. Routes model requests through
  *combos* (named, prioritized/weighted lists of provider targets), tracks
  quota/usage/cost, and exposes a management API behind dashboard-session or
  API-key auth.
- **oh-my-pi / omp** (`vendor/oh-my-pi`, from `can1357/oh-my-pi`, published as
  `@oh-my-pi/pi-coding-agent`) — a Bun-based terminal coding agent with a
  pluggable extension SDK.

omp is the front end: every LLM call it makes is routed through OmniRoute
(`providers.omniroute` in `~/.omp/agent/models.yml`), omp's model *roles*
(`default`, `smol`, `plan`, …) map to OmniRoute *combos*, and OmniRoute's own
controls (combos, quota, usage, fallback, health, sessions, key rotation) are
surfaced inside an omp session through the `/omni` command.

Both upstreams release roughly daily, so both are vendored as
`git subtree --squash` pulls (see `docs/upstream-sync.md`) — **vendored trees
are never hand-edited**. All custom integration code lives under
`integrations/` and `infra/`.

## Repository layout

```
vendor/omniroute/          OmniRoute, squashed subtree (never edited)
vendor/oh-my-pi/           oh-my-pi, squashed subtree (never edited)

integrations/
  omniroute-bridge/        Node/Bun library: OmniRoute lifecycle, key
                            provisioning, mock seeding, role mapping,
                            models.yml writing. No omp dependency.
  session-registry/       Shared local `/collab` link registry
                            (`~/.mywayai/sessions.json`) with atomic writes.
  omp-omniroute-extension/ omp extension (`/omni` and `/remote` commands + 2
                            agent tools). Deliberately duplicates ~60 lines
                            from the bridge (see "Extension vs. bridge
                            duplication" below) rather than depending on it.
  launcher/                `mywayai` CLI — composes the bridge's functions
                            into the day-to-day up/down/status/logs/sync
                            workflow, dashboard up/down/status/install
                            subcommands, then execs the pinned omp binary.
  e2e/                     Full-stack smoke test (bun:test) exercising the
                            real boot -> provision -> seed -> route chain.

infra/
  mock-provider/            Minimal OpenAI-compatible mock server for local
                             dev + e2e (no real upstream provider needed).
  docker-compose.yml         OmniRoute + mock-provider, containerized.

scripts/subtree-pull.sh     `git subtree pull --squash` for both upstreams.
docs/                       This file, quickstart.md, upstream-sync.md.
```

## Data flow

```
omp session
  │  model = "omniroute/<combo>"
  ▼
providers.omniroute (~/.omp/agent/models.yml)
  baseUrl: http://localhost:20128/api/v1
  api: openai-completions
  apiKey: !cat ~/.mywayai/omniroute.key
  │
  ▼
OmniRoute (vendor/omniroute, port 20128)
  resolves <combo> -> prioritized/weighted provider targets
  │
  ▼
Upstream provider (real API, or infra/mock-provider for dev/e2e)
```

Role mapping (`~/.omp/agent/config.yml` `modelRoles`) decides which combo a
given omp role (`default`, `smol`, `plan`, …) resolves to; `/omni role <role>
<combo>` changes it live (reloads omp's config), `omni_switch_combo` (an
agent tool) changes it for the *next* session.

## `integrations/omniroute-bridge`

The single source of truth for OmniRoute lifecycle and bootstrap logic.
Public surface (`src/index.ts`):

- `startOmniRoute` / `stopOmniRoute` / `isUp` — spawn/stop the vendored
  Next.js app via `Bun.spawn`, track a pidfile, poll `/api/health/ping` for
  readiness. Readiness means "the port answered an HTTP response at all" (200
  once authenticated, 401 pre-auth) — a fresh install's password requirement
  means it never returns 200 unauthenticated, and a fresh install's
  synchronous first-boot work (migrations, Arena Elo sync, MDX generation)
  can briefly block the event loop long enough for a tight per-request
  timeout to abort a response that was already on its way. Timeouts here are
  generous for exactly that reason (see `server.ts`'s own comments).
- `provisionKey` / `rotateKey` — obtain/regenerate an OmniRoute API key. See
  "Known issues" below for the retry logic and why it exists.
- `seedMock` — creates a mock provider node/connection/combo for dev/e2e.
  Never called by `mywayai up` unless `--seed-mock` is passed.
- `writeModelsYaml` — idempotently upserts the `providers.omniroute` block.
- `writeRoleMapping` — idempotently upserts `modelRoles` entries.

Every filesystem path (`getStateDir`, `getAgentDir`, …) honors env overrides
(`MYWAYAI_STATE_DIR`, `PI_CODING_AGENT_DIR`, `OMNIROUTE_PORT`) so tests and
alternate profiles can redirect state without touching a developer's real
`~/.mywayai` or `~/.omp/agent` — this is how `integrations/e2e` isolates
itself.

## Extension vs. bridge duplication

`integrations/omp-omniroute-extension/src/extension.ts` intentionally
duplicates its role-mapping and key-rotation helpers (~60 lines) rather than
importing `@mywayai/omniroute-bridge`. `@mywayai/omniroute-bridge` shells out
to `npm`/`node` and owns OmniRoute's process lifecycle — pulling it into the
extension bundle would drag that surface along for no reason the extension
needs. The duplication is small, explicitly commented at both call sites,
and each half only needs to change if OmniRoute's `/api/keys` or
`/api/combos` shapes change (rare, and would need updating in both places
either way since the request shapes themselves are still duplicated schema
knowledge, not shared code).

This is a per-dependency judgment call, not a blanket rule: the extension
*does* import `@mywayai/session-registry` (see "Remote control" below) for
its `/remote` command, because `bun build --target bun` bundles workspace
imports into the single standalone `dist/omniroute.js` it ships — there is
no runtime `node_modules` resolution either way, bundled or not — and
session-registry's locked, atomic read-modify-write is exactly the kind of
shared correctness-sensitive logic worth reusing rather than re-forking.

## Remote control

`@mywayai/session-registry` is the shared local store for dashboard-visible
`/collab` links: it writes `~/.mywayai/sessions.json` atomically, keeps the file
`0600` under a `0700` state directory, and prunes entries by pid liveness plus
last-active staleness. Writers serialize through `withLock`, so each heartbeat
or unregister can update and prune safely without callers adding their own
cross-process locking. A session is registered in two manual steps — run
`/collab`, then `/remote register <link>` — because the extension cannot invoke
the built-in slash command programmatically (verified against the published
`@oh-my-pi/pi-coding-agent` SDK types: no `executeCommand`/`runCommand` exists).
The dashboard proxies OmniRoute's `POST /api/auth/login` only as a credential
check, then mints its own signed `dash_session` cookie. It never reuses or
depends on OmniRoute's internal `auth_token` cookie.

## Known issues

### `provisionKey`'s authenticated mint can hang (server-side, unfixed)

`POST /api/keys` reached through **any** non-401 authentication path — a
dashboard session cookie *or* OmniRoute's own machine-id CLI-token header
(`x-omniroute-cli-token`, intended for exactly this local-bootstrap use case)
— has been observed to hang for 20–90+ seconds against an otherwise-healthy,
fully-booted OmniRoute instance in some environments. This was investigated
extensively and conclusively narrowed to OmniRoute's own server:

- **Not a client bug.** Reproduced identically via `curl`, Bun's `fetch`
  (with and without `keepalive: false`), and a real headless-Chromium browser
  driving the actual dashboard UI through a real login session.
- **Not specific to cookie auth.** OmniRoute's alternate machine-id CLI-token
  header (`isCliTokenAuthValid` in
  `vendor/omniroute/src/lib/middleware/cliTokenAuth.ts`) hangs identically.
- **Not the auth check itself.** `isDashboardSessionAuthenticated`'s JWT
  verification is pure, synchronous-cost crypto with no I/O; the CLI-token
  path's `getConsistentMachineId()` → `ioreg` subprocess call (macOS) was
  independently confirmed to return in ~250ms standalone.
- **Isolated to `POST /api/keys` specifically.** Other authenticated routes
  (`POST /api/keys/:id/regenerate`, `GET /api/combos`) are consistently fast
  once a valid credential is presented.
- A live V8 inspector stack sample taken mid-hang landed inside Node's
  `onStreamRead` (native stream/socket internals), not in any OmniRoute
  application code — consistent with a stalled read on some I/O the create-key
  handler's business logic performs, but the exact statement was not
  isolated without instrumenting vendored source, which this repo does not do.
- **Confirmed deterministic on a completely fresh environment.** Reproduced
  with identical timing (~43.5s, matching the retry-with-backoff worst case)
  on a from-scratch GitHub Actions `ubuntu-latest` runner — different OS,
  different hardware/virtualization, zero prior state, first-ever boot, first
  attempt (see PR #1's `build-and-e2e` CI run). This rules out any theory
  tied to a specific local machine, accumulated server state, or repeated
  usage: a genuinely first-ever `mywayai up` against a genuinely fresh
  OmniRoute install hits this reliably, not just occasionally.

Since the root cause is inside `vendor/omniroute` and this repo never patches
vendored trees, the mitigation lives entirely in `integrations/omniroute-bridge`:

- `provisionKey()` retries the authenticated mint once (`MINT_RETRY_ATTEMPTS
  = 2`, 3s backoff) before giving up — cheap insurance against a transient
  hang, at a bounded worst-case cost (2 × `BOOTSTRAP_FETCH_TIMEOUT_MS` + backoff).
- All bootstrap fetches use `keepalive: false` (a *real*, separately-confirmed
  bug: Bun's `fetch` reusing a keep-alive connection across sequential calls
  from the same long-lived process can itself hang against this server — fixed
  independently of the issue above).
- If retries are exhausted, the thrown error names the exact fallback:
  create a key from the dashboard manually and set `MYWAYAI_OMNIROUTE_KEY`.

If this manifests in your environment, `mywayai up` may take up to ~45
seconds longer than expected on first boot, or fail with an actionable error
directing you to the manual key path. `integrations/e2e`'s test exercises the
real flow (not a workaround) for exactly this reason — a clean CI runner may
not reproduce this at all, in which case the retry logic is a no-op safety
net rather than a load-bearing fix.
