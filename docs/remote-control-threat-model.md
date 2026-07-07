# Remote Control — threat model addendum

Companion to `docs/adr/0002-remote-control.md`, which has the architecture
and citations for every claim restated here. Same evidence-first style as
`docs/resilience-review.md`: each item is severity-rated, cites what was
actually read, and separates "mitigated" from "known, accepted gap." Nothing
below is inferred from the feature's *intent* — every claim traces to a
specific vendored file or a grep that came back empty.

## Scope

The remote channel added by Remote Control (`docs/adr/0002-remote-control.md`):
a self-hosted collab relay (R1), the omp session's `/collab` hosting of that
relay (R3/R4), and the browser client (R6). Does **not** cover OmniRoute's
own admin-surface exposure — that's `docs/resilience-review.md` F1/H1's
territory and is unchanged by this feature (Remote Control never opens a new
path to OmniRoute; it only lets a remote guest *prompt* the same local omp
session that already talks to OmniRoute through the existing `/omni`
extension and its approval-gated tools).

## Assets

- The collab link (room id + key [+ write token]) — the entire credential.
- Chat content flowing over the relay (prompts, agent replies, tool-call
  summaries/diffs rendered by the web client).
- The local machine's actual secrets (OmniRoute API key, provider API keys,
  file contents) — these must **never** appear on the wire; verifying that
  is the point of the test checklist's "no secret-bearing payload in relay
  traffic" item (`docs/resilience-review.md` F5/F6 already treats the
  OmniRoute key and provider keys as sensitive; this feature must not
  regress that).

## Threats

### T1 (High) — Leaked collab link

The link *is* the credential — `formatCollabLink`/`parseCollabLink`
(`vendor/oh-my-pi/packages/collab-web/src/lib/link.ts`) encode a 32-byte key
(view-only) or 32-byte key + 16-byte write token (full) with no separate
password or expiry. Whoever has it has that tier's access until the room is
rotated.

- **Vectors:** pasted into a durable chat/issue/log; shoulder-surfed QR code;
  browser history/autocomplete remembering the URL (the key lives in the URL
  **fragment**, which browsers keep in local history even though they never
  transmit it to a server); clipboard managers.
- **Mitigation:** treat the link as a bearer credential, because it is one —
  never post it anywhere durable. `/collab stop` then `/collab` mints a fresh
  room id and key, immediately invalidating every previously-issued link
  (including ones you meant to keep using — this is the only revocation
  mechanism available; see T4). R3's approval-mode warning bounds the damage
  a leaked *write* link can do if the operator has set
  `tools.approvalMode: write` — every `write`/`exec` tool still needs local
  confirmation regardless of who prompted it.
- **Residual (accepted for v1):** no per-device revocation; no link expiry
  beyond "the room is still open." Named explicitly in
  `docs/adr/0002-remote-control.md`'s "what this does not give you" section.

### T2 (Low–Medium, *unverified rather than asserted safe*) — Replay of a captured frame

AES-256-GCM with a random 12-byte IV per frame
(`vendor/oh-my-pi/packages/collab-web/src/lib/codec.ts:29-38`) authenticates
each frame and prevents forgery or IV-reuse key recovery. It does **not**,
by itself, stop an adversary who has captured valid ciphertext bytes from
re-submitting those exact bytes later.

- **Evidence of absence:** `WireFrame`/`GuestFrame`/`HostFrame`
  (`vendor/oh-my-pi/packages/wire/src/index.ts:301-380`) carry no sequence
  number, nonce, or timestamp field. A grep for
  `seq|nonce|replay|monoton` across `collab-web/src/lib` returned zero
  matches.
- **Practical exposure:** capturing ciphertext requires a position between a
  legitimate peer and the relay. Transport is `wss://` (TLS) in any
  non-localhost deployment, which bounds this to a compromised relay, an
  MITM'd TLS session, or an already-compromised legitimate endpoint — all of
  which grant an attacker capabilities well beyond "replay one old frame."
- **Mitigation:** never deploy the relay on plain `ws://` across a real
  network (R1 refuses to advertise a non-`wss://` relay URL as
  externally-reachable); keep rooms short-lived to narrow the window.
- **Explicitly not resolved here:** whether the *host's* guest-frame handling
  (deep in `AgentSession`, not read as part of this design pass) dedupes a
  replayed `entry`/`event` frame by id or would double-apply it is unknown.
  This is a named item in the test checklist rather than a claim either way.

### T3 (Low confidentiality / Medium availability) — Relay compromise

A fully compromised relay (attacker has root) still cannot read session
content — it only ever handles sealed ciphertext, room ids, connection
counts, and frame sizes ("the relay sees only..." — `vendor/oh-my-pi/docs/collab.md:71-75`).
The key never reaches it.

- **What it *can* do:** deny service to that room; observe room-id/traffic
  metadata (frame sizes and timing can weakly correlate with "a big tool
  result just happened"); if it also fronts TLS termination, see room ids in
  request paths (never the key — that stays in the URL fragment, sent to no
  server).
- **Mitigation:** operate the relay host with the same care as any other
  secret-adjacent box (patched, minimal, single-purpose); disable
  path-inclusive reverse-proxy access logs if room-id metadata matters for a
  given deployment's threat model.
- **Residual:** a compromised relay is a full DoS against remote control —
  **not** against the local OmniRoute/omp machine, which keeps running per
  the fail-safe ground rule (`docs/adr/0002-remote-control.md`'s framing).

### T4 (High while unlocked) — Device theft

A saved link (browser history, notes app, password manager) grants its tier
from any browser with no further authentication — there is no session PIN
separate from the link.

- **Mitigation:** don't persist the link anywhere durable on the device;
  rotate the room immediately on loss/theft (same mechanism as T1); default
  to sharing view-only links for "just checking status," reserving full
  (write) links for the device actively being used to send a message.
- **Residual:** identical root cause to T1 — no per-device credential to
  revoke individually. A stolen device with a saved link and no lock screen
  is equivalent to a leaked link (T1) until the room is rotated.

### T5 (Low) — No relay-level bearer auth; room ids visible in URL paths

`vendor/oh-my-pi/packages/collab-web/scripts/local-relay.ts`'s request
handler upgrades any request matching `/r/<roomId>?role=host|guest` on room
id alone (lines 49–61 as read) — unlike `omp auth-broker`/`auth-gateway`
(`vendor/oh-my-pi/docs/auth-broker-gateway.md`), which require
`Authorization: Bearer <token>` on every route but `/healthz`.

- **Why this is accepted rather than fixed:** the room id is 16 random bytes
  (128 bits, `ROOM_ID_BYTES` in `pi-wire/src/index.ts`) — brute force is
  infeasible. An attacker with *only* a leaked/logged room id (no key) can at
  most squat an unclaimed id before the real host connects (closes the
  legitimate host with 4009, a narrow race and a denial, not a read) or
  connect as a guest and receive frames it cannot decrypt without the key.
- **No action item** — documenting this so it's a known, understood
  property rather than a surprise finding later.

### T6 (Medium, self-inflicted if skipped) — Unbounded guests in the vendored reference relay

`startLocalRelay`'s `open()` handler (`local-relay.ts:63-82`) accepts
unlimited guests per room; the reference implementation never sends the 4029
("room is full") close code it advertises client-side. If a deployment
points `collab.relayUrl` at the raw vendored script instead of R1's wrapper
(`docs/adr/0002-remote-control.md`), "one remote session at a time" silently
reverts from an enforced control to a documentation-only policy.

- **Mitigation:** R1 *is* the enforcement point — a from-scratch, small relay
  under `integrations/remote-relay` that adds a per-room guest cap (default
  1) before forwarding to the host. Phase 5 docs must say this explicitly so
  nobody assumes the vendored script alone provides the cap.

### T7 (High if unaddressed) — Default `tools.approvalMode: yolo`

`tools.approvalMode` defaults to `yolo` (`vendor/oh-my-pi/docs/approval-mode.md:21`),
which auto-approves `exec`-tier tools, and any tool without a declared
`approval` — including, before R3, both `omni_usage` and
`omni_switch_combo` — defaults to `exec` (`approval-mode.md:11`). Under this
default, a remote guest's chat prompt can trigger `bash`, file edits, or
OmniRoute key/combo mutation with **no local confirmation**, exactly like a
locally-typed prompt would — this is not a remote-control-specific hole, but
remote control raises the stakes of the SDK's existing default.

- **Mitigation:** R3 tiers mywayai's own two tools correctly and prints a
  one-time warning when collab is configured while `approvalMode` resolves
  to `yolo`, naming the fix.
- **Explicitly not auto-fixed.** Per the "flag, don't silently decide"
  ground rule, mywayai never rewrites the operator's `tools.approvalMode`
  behind their back. The residual risk (auto-run exec-tier tools from a
  remote prompt) stays live until the operator changes the setting
  themselves. This is the single most consequential item in this document —
  everything else bounds confidentiality/availability of the *channel*; this
  one bounds what a remote message can *do*.

## Out of scope / accepted for v1

- Per-device credential issuance and revocation (collab has no identity
  layer to build this on; tracked as a gap in the ADR, not solved here).
- Push notifications / alerting when disconnected.
- Relay high availability, multi-region, or DDoS protection beyond whatever
  the operator's own hosting provides.
- Formal verification of guest-frame replay handling inside `AgentSession`
  (T2's residual item) — a test-checklist item, not a resolved claim.

## Headline comparison to Claude Code's own Remote Control

(Full version in `docs/adr/0002-remote-control.md`.) No account-backed
identity or per-device revocation; no managed relay; no cross-session audit
trail (the relay intentionally keeps no state beyond live connections); no
push notifications. This design trades those for: zero third-party
infrastructure dependency and content that stays E2EE regardless of who
operates the relay.
