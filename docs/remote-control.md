# Remote Control

Check on a running `mywayai` instance, or send it a chat message, from a
phone or another browser — while every actual agent step (the omp loop,
tool execution, OmniRoute admin calls, file access) keeps running only on
the machine `mywayai up` was invoked on. Full design rationale and
citations: `docs/adr/0002-remote-control.md`. Threat model:
`docs/remote-control-threat-model.md`.

## What it is

- A self-hosted relay (`mywayai relay`, `@mywayai/remote-relay`) that your
  local omp session connects to **outbound only** — it never opens an
  inbound port on the OmniRoute/omp machine.
- oh-my-pi's own built-in `/collab` live-session-sharing feature
  (`vendor/oh-my-pi/docs/collab.md`), wired up by `mywayai up --remote`.
- A browser page (the collab web client) that shows the live transcript,
  tool-call cards (including diffs for edits and previews for pending
  approvals), and a composer to send messages or approve/reject.

## What it is **not**

- Not a second execution environment. The remote device only prompts or
  interrupts; the local omp process is the only place any tool ever runs.
- Not account-backed. Access is capability-based (possession of a link),
  the same way a long, unguessable URL is — there is no login, no
  per-device credential, and no server-side revocation of one device
  without rotating the whole session for everyone.
- Not "as secure as" a vendor-managed remote-control product. See
  `docs/adr/0002-remote-control.md`'s "What this does not give you" and
  `docs/remote-control-threat-model.md` for the precise, unhedged
  comparison — no managed relay, no cross-session audit trail, no push
  notifications.

## Security guarantees, in plain language

1. **Outbound-only.** The OmniRoute/omp machine only ever makes outbound
   connections to the relay; nothing about this feature opens a port on it.
2. **The relay never sees your data.** Every message is sealed
   (AES-256-GCM) before it leaves the local process; the relay only ever
   handles ciphertext, room ids, and connection counts — never plaintext,
   never your OmniRoute key, never file contents.
3. **Approval still applies.** A message from a phone can only *prompt* the
   agent, exactly like typing locally — it goes through the same tool
   approval pipeline as everything else. Remote access adds no way to skip
   approval.
4. **A remote session never pauses local work.** If the network drops or a
   phone disconnects, the local omp process and OmniRoute keep running
   normally — see "Reconnection" below for exact numbers.
5. **One remote session per instance at a time (v1).** The self-hosted
   relay enforces a one-guest-per-room cap; sharing the link with a second
   device while the first is connected gets that second device rejected,
   not silently allowed in.

## Quick start

### 1. Boot the relay — on a *different host* from OmniRoute/omp

The relay is the one component in this design meant to be reachable from
outside — it must not run on the same machine as OmniRoute, or the
outbound-only guarantee for that machine is void.

```sh
# On a small host you control (a VPS, a spare box — not the OmniRoute machine):
MYWAYAI_RELAY_ACKNOWLEDGE_PUBLIC_BIND=1 mywayai relay up --port 8787
```

Put a TLS-terminating reverse proxy in front of it for anything beyond
local testing (this repo delegates TLS to the operator the same way
`vendor/oh-my-pi/docs/auth-broker-gateway.md` does for its own broker/gateway
pair — a one-line Caddy config is the simplest option). Point
`wss://your-relay-host/` at the plain `ws://127.0.0.1:8787` the relay binds
to internally.

For local-only testing on one machine (never for real remote access — a
relay bound to `127.0.0.1` is not reachable from a phone):

```sh
mywayai relay up --port 8787 --bind 127.0.0.1
```

### 2. Start omp with remote control on

On the OmniRoute/omp machine:

```sh
mywayai up --remote --relay wss://your-relay-host/ --name "laptop-dev"
```

This writes `collab.relayUrl` into `~/.omp/agent/config.yml`, then the omp
session (via `integrations/omp-omniroute-extension`) automatically runs
`/collab` at startup and prints the join link and QR code in your terminal —
exactly as it would if you typed `/collab` yourself.

Once configured, later runs don't need `--relay` again — `mywayai up
--remote` alone reuses the configured relay:

```sh
mywayai up --remote
```

### 3. Open the link on your phone

Paste the printed link into any mobile browser, or scan the QR code. No app
install. See "The web client" below for where that page is actually served
from.

## Session naming

Pass `--name <label>` to `mywayai up`/`mywayai daemon up` to distinguish
multiple instances (e.g. `dev` vs. a production OmniRoute). Without it, the
session name defaults to `<hostname>:<port>`. Set via
`ExtensionAPI.setSessionName` in the omp extension's `session_start`
handler — visible in the collab session state and in `/omni` output.

## Approval and safety

Remote-triggered tool calls go through the exact same approval pipeline as
local ones (`vendor/oh-my-pi/docs/approval-mode.md`) — remote access adds no
bypass. Two things worth knowing:

- The omp SDK's own default is `tools.approvalMode: yolo`, which
  auto-approves everything, including `write`/`exec` tools. If you start
  `--remote` with this default still in place, the extension prints a
  one-time warning naming the risk and the fix (`tools.approvalMode: write`
  or `always-ask` in `~/.omp/agent/config.yml`). mywayai never changes this
  setting for you — it only tells you when it matters.
- The two OmniRoute tools this repo ships (`omni_usage`, `omni_switch_combo`)
  are tiered correctly: usage lookups are `read` (safe to auto-approve
  under any mode), combo/role switches are `write` (require confirmation
  under any mode except `yolo`).

## Reconnection and limits

- **Laptop sleep / short network drops:** handled automatically. omp's
  collab connection (host side) reconnects with exponential backoff,
  1 second up to 30 seconds between attempts
  (`vendor/oh-my-pi/packages/collab-web/src/lib/socket.ts`
  `BACKOFF_BASE_MS`/`BACKOFF_MAX_MS` — the host-side connection mirrors the
  same semantics per that file's own header comment). No action needed on
  either end; the local omp process and OmniRoute are never paused by a
  network blip.
- **When to manually restart:** if reconnection is still failing after
  **30 minutes**, treat the session as needing a manual restart rather than
  waiting longer — `/collab stop` then `/collab` again (interactive), or
  `mywayai daemon down && mywayai daemon up --remote` (daemon). This is
  **operator guidance, not a code-enforced timeout**: mywayai does not sit
  between the interactive session and its own reconnect loop, so nothing in
  this repo can time it out for you. State this plainly rather than
  pretend otherwise.
- **One remote session per instance, enforced.** `@mywayai/remote-relay`
  caps each room at 1 connected guest (`MYWAYAI_RELAY_MAX_GUESTS`,
  default 1) — a second device trying to join a room that already has one
  gets rejected (WebSocket close code 4029, "room is full"), not silently
  admitted. This is a **known v1 limitation, not a permanent design
  choice** — collab's own protocol supports multiple simultaneous guests;
  raising the cap is a one-flag change (`mywayai relay up --max-guests <n>`)
  when multi-device sharing is actually wanted.

## The web client

No new frontend was built for this. Two ways to get the browser page:

1. **Zero build (default).** Point any build of the public collab web
   client at your own relay via the link's fragment — the static page
   itself never touches your session data once it loads; it connects
   straight to the relay named in the fragment over `wss://`, and the
   AES-256-GCM key never leaves that fragment either way
   (`vendor/oh-my-pi/docs/collab.md` link-format table). This is what
   `mywayai up --remote` prints by default.
2. **Fully self-hosted.** For zero reliance on any third-party-hosted
   static asset, build the client yourself from a **separate, standalone
   clone** of `github.com/can1357/oh-my-pi` (not this repo's vendored
   reference copy — see `docs/adr/0002-remote-control.md` R6 for why this
   repo doesn't build it in-tree):

   ```sh
   git clone https://github.com/can1357/oh-my-pi
   cd oh-my-pi && bun install
   cd packages/collab-web && bun run build   # static site in dist/
   ```

   Host `dist/` anywhere (the relay host itself, GitHub Pages, any static
   host) and set `collab.webUrl` in `~/.omp/agent/config.yml` to it.

## Known v1 limitations

- One remote session (one connected guest) per instance at a time — see
  "Reconnection and limits" above.
- Remote control requires a live, locally-attached interactive omp session
  (`mywayai up --remote`) by default. `mywayai daemon up --remote`
  (headless, no attached terminal) exists as an explicitly-flagged
  experiment but does **not currently work** — empirically confirmed
  against this repo's pinned omp version; see
  `docs/adr/0002-remote-control.md`'s "Open question" section for the exact
  evidence. Use the interactive path.
- No per-device credential or revocation — rotating the room
  (`/collab stop` + `/collab`) is the only way to cut off one device, and
  it disconnects every other legitimately-joined device too.
- No push notifications — "checking on it from a phone" means having the
  browser tab open.

## Open question the operator must decide

`docs/adr/0002-remote-control.md`'s "What already exists" section notes
collab's guest tiers are **link possession**, not a per-device identity —
this repo cannot decide for you whether that meets a given deployment's
compliance bar (e.g. an environment with its own access-control or
audit-logging requirements independent of anything mywayai or oh-my-pi
ship). Read the threat model before turning this on for anything beyond
personal, single-operator use.
