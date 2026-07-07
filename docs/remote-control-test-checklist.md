# Remote Control — test checklist

Companion to `docs/adr/0002-remote-control.md` and
`docs/remote-control-threat-model.md`. Items marked **[verified this
session]** were actually run against real code (real relay, real omp
`--mode rpc` process) during implementation — not just typechecked; see the
inline evidence. Items without that mark need a live two-device run and are
listed with the exact commands to do it.

## 1. Relay correctness — **[verified this session]**

Run against a real `@mywayai/remote-relay` instance with real WebSocket
clients (room create/join, guest cap, close-code semantics):

- [x] Host connects, creates a room.
- [x] First guest joins successfully; host receives `{"t":"peer-joined","peer":1}`.
- [x] **Second guest is rejected** with close code `4029` ("room is full")
      when `maxGuestsPerRoom` is at its default of 1 — the technical
      enforcement of the "one remote session at a time" v1 limitation.
- [x] Binary envelope forwarding both directions (guest→host peerId
      rewrite; host→guest broadcast on peerId 0, targeted send on peerId N).
- [x] Guest joining a room with no host closes with `4004` ("no such room").
- [x] A second host for an already-hosted room closes with `4009` ("a host
      is already connected for this room").
- [x] Host disconnecting sends `{"t":"room-closed"}` then closes every
      guest with `4001`.
- [x] `GET /healthz` returns `200 {"status":"ok","rooms":N}`; an unrelated
      path returns `404`.
- [x] Full `mywayai relay up/status/logs/down` CLI lifecycle via real
      spawned processes: status correctly reports down → up → down, log
      file contains the startup line, pidfile is removed on `down`.

Re-run manually any time `integrations/remote-relay/src/relay-core.ts`
changes:

```sh
mywayai relay up --port 18787 --bind 127.0.0.1
mywayai relay status --port 18787
mywayai relay logs
mywayai relay down
```

## 2. Config wiring — **[verified this session]**

- [x] `writeCollabConfig` writes `collab.relayUrl`/`collab.displayName`
      into a fresh `config.yml`.
- [x] A second `writeCollabConfig` call idempotently replaces `relayUrl`
      while **preserving** a previously-written `displayName` it didn't
      re-specify.
- [x] A non-`ws(s)://` relay URL is rejected with a clear error before any
      file write happens.
- [x] `mywayai up --remote` with no `--relay` flag and no prior
      `collab.relayUrl` throws the actionable "requires a relay URL" error
      **before** touching OmniRoute lifecycle. With an explicit `--relay`,
      or with a previously-configured relay, it resolves correctly.

## 3. Approval gate still enforced remotely — needs a live run

Not fully verifiable without a real two-participant collab session (a real
model call is needed to reach a `tool_call`). Do this manually:

1. `mywayai up --remote --relay <your-relay>` with
   `tools.approvalMode: write` set in `~/.omp/agent/config.yml`.
2. Join the printed link from a second device.
3. From the remote device, prompt something that would trigger
   `omni_switch_combo` (a `write`-tier tool) — e.g. "switch the default
   role to test-combo".
4. **Expect:** the LOCAL terminal shows an approval prompt exactly as it
   would for a locally-typed request; the tool call does **not** run until
   approved locally. The remote device shows the pending/approval state
   (via collab's tool-call card) but cannot approve it itself — approval
   is host-only per `vendor/oh-my-pi/docs/collab.md:92` ("Everything that
   mutates the host session or machine is host-only").
5. Approve locally; confirm the remote device's transcript updates with
   the result.
6. Repeat with `tools.approvalMode: yolo` (the SDK default) and confirm the
   extension printed its one-time warning at session start naming this
   exact risk (`docs/adr/0002-remote-control.md` R3) — then confirm the
   tool call **does** auto-run with no prompt, proving the warning
   accurately describes the live behavior rather than overstating safety.

## 4. Message delivery — needs a live run

1. `mywayai relay up` on host A.
2. `mywayai up --remote --relay <A>` on host B (the OmniRoute machine).
3. From a phone/browser, open the printed link.
4. Send a chat message from the phone. **Expect:** it appears in host B's
   local terminal transcript with the remote participant's display name
   badge (`vendor/oh-my-pi/docs/collab.md:86` — "rendered with their name
   badge on every participant's transcript").
5. Send a reply from the local terminal. **Expect:** it streams to the
   phone in real time (assistant text, thinking, tool-call cards).
6. Confirm the phone's composer can also send follow-up messages and an
   interrupt (Esc-equivalent in the web client) while a turn is streaming.

## 5. Reconnect after network drop — needs a live run

1. With a session shared as in §4, put the OmniRoute/omp machine to sleep
   (or disable its network) for **under 30 seconds**, then restore it.
   **Expect:** automatic reconnect, no visible session loss on either side
   — `docs/remote-control.md` "Reconnection and limits" documents the
   1s–30s exponential backoff this relies on
   (`vendor/oh-my-pi/packages/collab-web/src/lib/socket.ts`).
2. Repeat with a **2–5 minute** drop. **Expect:** same automatic recovery,
   possibly with a brief "reconnecting" indicator in the web client.
3. Confirm throughout: the local omp process and OmniRoute keep running and
   accepting local input the entire time — the fail-safe ground rule holds
   independent of whether the remote link ever reconnects. This is the
   most important assertion in this checklist; a regression here is P0.
4. Kill the relay process entirely (`mywayai relay down`) while a guest is
   connected. **Expect:** the guest gets a close, the host's own local
   session is completely unaffected (still running, still accepting local
   prompts) — confirming the relay is a pure conduit, never a dependency of
   local execution.

## 6. Daemon (Option 2, experimental) — **[verified this session, confirmed broken]**

- [x] `startDaemon` boots `omp --mode rpc` successfully; `isDaemonUp()`
      reports `true`; pidfile is written.
- [x] With `remote: true`, the `/collab` autostart attempt is sent over RPC
      stdin.
- [x] **Confirmed via a real RPC process (not inferred):** `/collab` is not
      in the RPC `available_commands_update` list, and the sent text is
      echoed back as an ordinary chat message followed by a real model
      turn — contrasted directly against `/jobs`, a genuinely RPC-recognized
      local-only command, which instead responds with
      `data.agentInvoked:false` and no model call.
- [x] The daemon's own detector correctly reports this failure (not a false
      positive from a naive "does the log mention 'collab'" check, which
      *would* false-positive here since the failed attempt's echoed text
      itself contains the substring "collab").
- [x] The daemon process itself keeps running normally after the failed
      `/collab` attempt — confirmed via `isDaemonUp()` immediately after.
- [ ] **Re-run after any `@oh-my-pi/pi-coding-agent` version bump**
      (`docs/upstream-sync.md` "Version pins to watch"): a future omp
      release may add RPC support for `/collab`. Re-run the probe below and
      update `docs/adr/0002-remote-control.md`'s "Open question" section
      with the new result either way.

```sh
# Minimal reproduction (no OmniRoute needed — /collab does not depend on it):
PI_CODING_AGENT_DIR=/tmp/probe ANTHROPIC_API_KEY=fake-test-key \
  bun integrations/launcher/node_modules/.bin/omp --mode rpc
# In another terminal, or via a small script, write to its stdin:
#   {"type":"prompt","id":"t1","message":"/collab"}
# Compare the "prompt" response for id "t1":
#   still contains no "data" field + is followed by agent_start -> still broken
#   contains "data":{"agentInvoked":false} -> now fixed, update the ADR
```

## 7. No secret-bearing payload ever reaches the relay

- [ ] With a session shared as in §4, capture relay-side traffic (e.g. run
      the relay under a debug proxy, or temporarily log raw frame bytes at
      the relay for this test only — never in production, per the threat
      model's confidentiality-by-design point). Confirm every frame is
      opaque ciphertext of unpredictable length relative to content — no
      plaintext substring matches for: the OmniRoute API key
      (`~/.mywayai/omniroute.key`), any provider API key, or raw file
      contents from the local machine.
- [ ] Ask the remote agent (from the phone) to read a local file containing
      a known marker string. Confirm the marker string does **not** appear
      anywhere in the relay's own logs (only in the sealed frame payload,
      and only decryptable by a peer holding the room key) — the relay
      should log at most room ids, connection counts, and frame sizes,
      per `docs/remote-control-threat-model.md` T3.
- [x] **Design-level check (verified by reading, not runtime capture):**
      `integrations/remote-relay/src/relay-core.ts`'s message handler never
      parses, logs, or branches on frame *content* — only the plaintext
      4-byte peerId prefix (`readEnvelopePeerId`/`rewriteEnvelopePeerId`).
      There is no `console.log`/file-write of any frame payload anywhere in
      that file.
- [ ] Confirm the relay's own process log (`mywayai relay logs`) contains
      only startup/shutdown lines and no per-message content — grep it
      after a full test session for anything resembling chat text.
