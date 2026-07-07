---
status: accepted
date: 2026-07-07
decision: "Self-host oh-my-pi's own /collab relay (vendored, unedited) under operator control; reject the my.omp.sh default relay, VPN mesh tunnels, and ngrok-style inbound tunnels. R5: ship both execution-model options (user's explicit call, see Open question) — Option 1 (interactive /collab) is the default; Option 2 (headless RPC daemon) ships as a flagged experiment and was empirically confirmed NOT to work with the pinned omp version, see below."
---

## Remote Control — checking on / messaging a running mywayai instance from a phone or another browser

### Framing

"Remote control" here means: the person running `mywayai up` (OmniRoute + an omp
session, `docs/architecture.md`) can see status and send chat messages from a
phone or a second browser, while every actual agent step this repo has —
the omp agent loop, tool execution, OmniRoute admin calls, and
all file access — keeps running exclusively on the machine `mywayai up` was
invoked on. No inbound port on that machine. No API key, config file content,
or file content leaves the process except as chat text a human can read.

### What already exists (this is the load-bearing discovery)

oh-my-pi ships this feature already, under `/collab`
(`vendor/oh-my-pi/docs/collab.md`) — it is not something mywayai needs to
build from scratch, and per `docs/upstream-sync.md` the vendored tree is
never hand-edited, so the design below is "wire it up," not "reimplement it."

Verified properties (file-cited, not inferred):

- **Host-authoritative, outbound-only.** "the host machine runs the agent and
  all tools" (`collab.md:3`). The `CollabSocket` class
  (`vendor/oh-my-pi/packages/collab-web/src/lib/socket.ts`) only ever opens
  an outbound `WebSocket` to the relay; nothing in the vendored client or
  relay code listens for inbound connections on the host side.
- **Content-blind, E2EE relay.** Every frame is AES-256-GCM sealed
  client-side before it touches the socket
  (`vendor/oh-my-pi/packages/collab-web/src/lib/codec.ts`); "the relay sees
  only: room ids and connection counts, opaque ciphertext frames and their
  sizes, a 4-byte routing prefix" (`collab.md:71-75`). The room key is
  generated in-browser/in-process and "never leaves the URL fragment — it is
  not sent to the relay or any server" (`collab-web/README.md:28`).
- **Two guest tiers, not per-device credentials.** A link is either a 48-byte
  full link (32-byte key + 16-byte write token — prompt/interrupt/subagent
  control) or a 32-byte view-only link (key only, read-only)
  (`collab.md:62-77`, `pi-wire/src/index.ts` `ROOM_KEY_BYTES`/`WRITE_TOKEN_BYTES`).
  There is no per-device identity: `Participant.name` is a self-reported,
  unauthenticated display string (`pi-wire/src/index.ts:217-222`), and the
  guest `hello` frame's only credential is possession of the write token
  (`pi-wire/src/index.ts:324-335`). This is a real gap against the "separate
  token per device" ground rule — flagged in the threat model, not hidden.
- **Approval is not bypassed.** "Everything that mutates the host session or
  machine is host-only: `/model`, `/compact`, `/resume`, `/branch`, bash
  (`!`), python (`$`), skills, etc." (`collab.md:92`). Guests can only
  `prompt`/`abort`/`agent-cmd` (`pi-wire/src/index.ts:336-340`) — ordinary
  chat input that flows through the *same* `AgentSession` prompt path, hence
  the *same* `tool_call` approval pipeline
  (`vendor/oh-my-pi/docs/approval-mode.md`,
  `vendor/oh-my-pi/docs/extensions.md` "Tool lifecycle" events) as anything
  typed locally. Nothing in the collab protocol has a separate "skip
  approval" path.
- **A ready-made, diff-aware web client already exists.**
  `vendor/oh-my-pi/packages/collab-web` is a standalone (no
  `@oh-my-pi/pi-coding-agent` dependency) static SPA the relay serves at `/`.
  Its `src/tool-render/tools/` directory already has per-tool renderers
  including `edit.tsx`, `ast-edit.tsx`, `resolve.tsx`, `bash.tsx`, and
  `write.tsx` — i.e. it already renders the diff/preview for exactly the
  "resolve" apply/discard flow (`vendor/oh-my-pi/docs/resolve-tool-runtime.md`)
  this task's Phase 3 asks for, out of the box.
- **Provider-agnostic.** Collab operates on `WireMessage`/`AgentEvent`/`WireModel`
  (`pi-wire/src/index.ts`), which already sit above omp's provider
  abstraction — no LLM-provider-specific branching anywhere in the relay or
  client. Satisfies the "match mywayai's multi-provider design" constraint
  for free.
- **A reference relay is vendored, not just documented.**
  `vendor/oh-my-pi/packages/collab-web/scripts/local-relay.ts` is a complete,
  working `Bun.serve` implementation of "the exact relay contract the real
  clients expect" (its own header comment) — room create/join, host/guest
  framing, 4001/4004/4009 close codes, no persistence beyond live
  connections. It has **no guest-count cap** and **no relay-level bearer
  auth** as shipped (see threat model).

### Options compared

| | A: default `wss://my.omp.sh` | B: self-hosted collab relay (chosen) | C: Tailscale / ZeroTier mesh | D: ngrok / inbound tunnel |
|---|---|---|---|---|
| Setup | zero — works immediately | operator runs the relay on a small reachable host + TLS-terminating reverse proxy | install + authenticate a VPN client on **every** device, including the phone | `ngrok http <port>` on the OmniRoute host |
| Meets Phase 3's "browser only, no app install" requirement | yes | yes | **no** — a bare mobile browser cannot reach anything until the Tailscale/ZeroTier app is installed and joined to the tailnet | yes, but see confidentiality row |
| Outbound-only from the OmniRoute/omp host | yes | yes | yes (mesh connections are outbound-initiated/hole-punched) | **no** in the way this task means it — the whole point of ngrok is to make an inbound port reachable from the internet; this re-opens exactly the exposure `docs/resilience-review.md` F1/H1 closed (LAN → now internet) |
| Confidentiality vs. the relay/tunnel operator | E2EE; operator is the oh-my-pi maintainers | E2EE; operator is mywayai's own operator | full LAN-equivalent reachability once joined — no E2EE needed, but a compromised device on the tailnet sees everything that device can reach | **plaintext to ngrok's cloud** unless the app adds its own E2E layer (collab already does this; ngrok-under-collab is redundant) |
| Third-party infra dependency | yes (`my.omp.sh`) | no | yes (coordination plane) | yes (ngrok cloud) |
| Fits mywayai's existing "operator owns their own infra" pattern (OmniRoute self-hosting, `auth-broker-gateway.md`'s broker-on-a-host-you-control model) | no | **yes** | partially — same delegation pattern `auth-broker-gateway.md` already recommends, but wrong shape for "any phone browser" | no |
| New code required | none | small — relay lifecycle wrapper + config wiring, reusing vendored crypto/client unedited | none on mywayai's side, but per-device app installs are a real ongoing cost | none on mywayai's side |

**Recommendation: B, self-host the reference relay.** It is the only option
that satisfies Phase 3's literal requirement (a bare browser, no app install)
*and* keeps confidentiality independent of who operates the relay *and*
avoids a third-party infrastructure dependency — matching the posture this
repo already takes with OmniRoute itself and with `auth-broker-gateway.md`'s
"move credentials onto a host you control" pattern. `my.omp.sh` (A) is kept
as a documented zero-setup fallback for a two-minute local demo, never as the
default for anything the ADR would call "remote access." C is rejected as
the *primary* channel because it fails the browser-only requirement outright
(it remains a fine choice for the operator's own trusted devices, exactly as
`auth-broker-gateway.md` already recommends for broker/gateway traffic — a
different, machine-to-machine problem). D is rejected because an inbound
tunnel is structurally the thing the outbound-only ground rule exists to
prevent.

### What this does **not** give you, compared to Claude Code's own Remote Control

State this plainly, not by inference:

- **No account-backed identity or per-device revocation.** Access is
  capability-based (possession of a link), not tied to an authenticated user
  identity. Revoking one device means rotating the whole room (`/collab
  stop` + `/collab`), which also disconnects every other legitimately
  joined device.
- **No managed relay.** Uptime, patching, TLS renewal, and DDoS exposure of
  the relay host are the operator's problem, not a vendor's.
- **No cross-session audit trail.** The relay "keeps no state beyond live
  connections" (`collab.md:114`) by design, for confidentiality — there is
  no built-in log of who connected when, beyond whatever the operator's own
  reverse-proxy access logs capture (and those only ever see the room id, an
  IP, and a timestamp — never the key, never content).
- **No push notifications.** This is a pull/socket model: "checking on it
  from a phone" means having the browser tab open, not receiving an alert.

### Concrete build items (numbering continues from `docs/resilience-review.md`'s H1–H10 and `0001-distribution.md`'s D1–D3, i.e. starting at order 13)

#### R1 — `integrations/remote-relay`: relay lifecycle package (order 13, complexity S)

New workspace package, sibling to `omniroute-bridge`, same shape
(`startRelay`/`stopRelay`/`isRelayUp`, pidfile under `getStateDir()`, health
probe, generous startup timeout — mirrors `omniroute-bridge/src/server.ts`
exactly). The relay implementation itself is a small, from-scratch TS module
under `integrations/remote-relay/src/` that speaks the same wire contract
documented in `vendor/oh-my-pi/packages/collab-web/scripts/local-relay.ts`
(read for the contract, never imported — `collab-web` is `"private": true`
and not published, so it cannot be a runtime dependency of `integrations/`
the same way `@oh-my-pi/pi-coding-agent` is) — with one deliberate addition:
**a per-room guest cap, default 1**, closing the (N+1)th guest with 4029
("room is full") before it reaches the host. This turns "one remote session
per instance at a time" from a documentation request into an enforced
control. Default bind is `0.0.0.0` — this is the *one* component in this
design that is supposed to be reachable, and it must run on a host that is
**not** the OmniRoute/omp machine, or the outbound-only guarantee for that
machine is void. `mywayai relay up` refuses to start unless
`MYWAYAI_RELAY_ACKNOWLEDGE_PUBLIC_BIND=1` (or an explicit `--bind 127.0.0.1`
for local-only testing) is set, so nobody gets a silently-wide-open relay the
way OmniRoute originally did (F1) — the difference here is the *intended*
default is wide, so the guard is an explicit acknowledgement, not a
localhost default.

#### R2 — `mywayai relay up/down/status` (order 14, complexity XS)

New subcommands in `integrations/launcher`, entirely independent of
`mywayai up`/`down`/`status` (different process, typically a different
host). Same pidfile/log-tail UX as the existing commands.

#### R3 — Session identity, tool tiers, and an approval-mode warning (order 15, complexity XS)

In `integrations/omp-omniroute-extension/src/extension.ts`'s `session_start`
handler:

- Call `ctx.setSessionName(...)` (`ExtensionAPI`, `extensions.md:122`) with a
  name derived from `MYWAYAI_SESSION_NAME` (settable via `mywayai up --name
  <n>`) or a `<hostname>:<port>[-mock]` default — satisfies "session naming
  so multiple instances can be told apart" without any new omp CLI surface.
- Declare `approval: "read"` on `omni_usage` and `approval: "write"` on
  `omni_switch_combo` (currently undeclared, which `approval-mode.md:11`
  says defaults to `exec`). Small, targeted, additive change to code this
  repo owns — never touches `vendor/`.
- If `tools.approvalMode` resolves to `yolo` (the SDK default,
  `approval-mode.md:21`) and `collab.relayUrl` is configured to something
  other than empty, print a one-time warning naming the exact risk: every
  `write`/`exec` tool call — including ones a remote guest's chat message
  triggers — will auto-run with no local confirmation, and naming the fix
  (`tools.approvalMode: write` in `~/.omp/agent/config.yml`). This never
  changes the setting itself — "flag, do not silently decide."

#### R4 — `writeCollabConfig()` (order 16, complexity XS)

New function in `integrations/omniroute-bridge`, same idempotent-upsert
shape as `writeModelsYaml`/`writeRoleMapping`, writing `collab.relayUrl`
(pointed at the operator's self-hosted relay from R1) and a
`collab.displayName` default into `~/.omp/agent/config.yml`. Uses the same
atomic tmp-file-then-rename write this repo's resilience work already
established for config files, independent of whether that work has landed
elsewhere.

#### R5 — the actual "background process that registers with the relay" (order 17, complexity M — both options shipped, see Open question)

#### R6 — Phase 3 web client (order 18, complexity XS — corrected during implementation)

No new frontend, and — corrected from the original plan after actually
trying it — mywayai does not build `vendor/oh-my-pi/packages/collab-web`
either: this repo's own stated convention is that `vendor/oh-my-pi` is
"reference-only for seam auditing... integrations consume the published
`@oh-my-pi/pi-coding-agent` npm package, never this tree" (root `README.md`).
Confirmed live: `vendor/oh-my-pi/node_modules` has never been installed in
this repo, and `collab-web`'s own dependency graph (`@oh-my-pi/pi-wire` via
the `catalog:` protocol) is unresolvable without a separate `bun install` at
`vendor/oh-my-pi`'s own root — building it from inside this repo would be a
first-time convention break, not "glue and docs."

Two paths instead, both zero-new-code, documented in `docs/remote-control.md`:

1. **Zero build (default).** Collab's own link grammar already supports
   pointing a publicly-hosted *web UI* at a privately-hosted *relay*:
   `https://web-host/[<path>]/#relay.example.com/r/<roomId>.<key>`
   (`vendor/oh-my-pi/docs/collab.md:56-57`). The static JS served from
   `my.omp.sh` (or any other build of the same open-source, non-sensitive
   client) never enters the data path once the page loads — it connects
   straight to the relay named in the link fragment over `wss://`, and the
   AES-256-GCM key never leaves that fragment. Using the public host to
   serve *only the UI shell* while the actual session stays on a
   self-hosted relay does not reintroduce the third-party-infrastructure
   dependency this ADR rejects elsewhere — if that static host is ever
   unreachable, any other build of the same public client works identically
   (it is public, non-sensitive code).
2. **Fully self-hosted (optional).** Operators who want zero reliance on
   any third-party-hosted asset build `collab-web` from a **separate,
   standalone clone** of `github.com/can1357/oh-my-pi` (not this repo's
   vendored copy) — `git clone`, `bun install`, `cd packages/collab-web &&
   bun run build` — and host the static `dist/` output anywhere, with
   `collab.webUrl` pointed at it.

### Open question — which shape does R5 take? (resolved: both, by explicit user decision)

This was the checkpoint the task instructions call for: *"stop and ask before
Phase 2 if the relay choice has an open question that changes the local
agent's design."* The relay choice itself (R1–R4, R6 above) was never
blocked by this. What was genuinely open, and asked about directly:

- **Option 1 — piggyback on the operator's live interactive session.**
  `mywayai up --remote [--relay <url>]` also runs `/collab` at startup (via
  the omp extension's `session_start` handler, R3) and prints the join
  link/QR through the normal interactive TUI. Reuses `/collab` exactly as
  documented. Remote control only exists while a human has that terminal
  open — closing it ends the shared session (documented v1 limitation, not
  a permanent design choice, per the ground rules).
- **Option 2 — a true headless background process**, closer to how OmniRoute
  itself is a background service. `mywayai daemon up --remote` runs `omp
  --mode rpc` (`vendor/oh-my-pi/docs/rpc.md`) instead of the interactive
  TUI and attempts to drive `/collab` over the RPC stdin channel.

**User's decision:** ship both — Option 1 as the default, Option 2 as an
explicitly-flagged experiment (`integrations/launcher/src/daemon.ts`).

**Empirical result for Option 2 (tested against a real `omp --mode rpc`
process from this repo's pinned `@oh-my-pi/pi-coding-agent@16.3.11`, not
inferred from docs):** it does not work. Sending
`{"type":"prompt","message":"/collab"}` over RPC stdin does **not** register
as a slash command:

- The RPC `available_commands_update` frame — which lists every builtin
  command by name — never includes `"collab"`.
- The sent text comes back as an ordinary `role:"user"` chat message,
  followed by a real `agent_start`/model turn (verified with a deliberately
  invalid API key: the turn failed with a genuine `401 invalid x-api-key`
  from Anthropic's API, proving a real provider call was attempted).
- Contrast with a command that *is* RPC-recognized (`/jobs`, tested the same
  way): it returns `{"type":"command_output",...}` plus a `prompt` response
  carrying `"data":{"agentInvoked":false}` and **no** `agent_start` at all —
  the documented (`rpc.md`) local-only-command shape. `/collab`'s response
  carries no `data` field and is immediately followed by a full model turn.

`daemon.ts` ships anyway, with this exact detection logic built in (look for
`"agentInvoked":false` alongside the known request id; its absence plus a
following model turn is the confirmed failure signature) — the daemon
process itself was verified to keep running normally even when the `/collab`
attempt fails (fail-safe property holds independent of this), and the CLI
reports the failure plainly rather than pretending success. Re-test after
any `@oh-my-pi/pi-coding-agent` version bump
(`docs/upstream-sync.md` "Version pins to watch") — a future release may add
RPC support for `/collab`, at which point the same detector will correctly
report success without further changes.
