// Filesystem locations for the relay's own lifecycle state. Deliberately
// independent of @mywayai/omniroute-bridge's paths: this process is meant to
// run on a *different host* from OmniRoute/omp in any real deployment (see
// docs/adr/0002-remote-control.md — the relay is the one component in this
// design that must be inbound-reachable, so it must not share a machine
// with the outbound-only OmniRoute/omp host). Reusing the `~/.mywayai`
// directory name on whatever host this runs on keeps the mental model
// ("mywayai state lives under ~/.mywayai") consistent without coupling the
// two processes' state.

import { homedir } from "node:os";
import { join } from "node:path";

export function getRelayStateDir(): string {
  return process.env.MYWAYAI_RELAY_STATE_DIR ?? process.env.MYWAYAI_STATE_DIR ?? join(homedir(), ".mywayai");
}

export function getRelayLogDir(): string {
  return join(getRelayStateDir(), "logs");
}

export function getRelayLogFile(): string {
  return join(getRelayLogDir(), "relay.log");
}

export function getRelayPidFile(): string {
  return join(getRelayStateDir(), "relay.pid");
}

// Distinct from OmniRoute's 20128 and infra/mock-provider's 9999 so all
// three can run on one box during local development without a collision.
export const DEFAULT_RELAY_PORT = 8787;

// Used by startRelay/isRelayUp (server.ts), the spawned CLI's own flag
// parsing (relay-cli.ts), and the status subcommand (cli.ts) — three
// independent call sites that must resolve the same value the same way.
export function resolveRelayPort(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const fromEnv = process.env.MYWAYAI_RELAY_PORT;
  return fromEnv ? Number(fromEnv) : DEFAULT_RELAY_PORT;
}

// Intentionally wide by default: unlike OmniRoute (docs/resilience-review.md
// F1/H1), this process exists specifically to be reachable from outside the
// host it runs on. `startRelay` (server.ts) still requires an explicit
// acknowledgement before binding wide — see MYWAYAI_RELAY_ACKNOWLEDGE_PUBLIC_BIND.
export const DEFAULT_RELAY_BIND = "0.0.0.0";

// One connected remote device/tab per room by default — the technical
// enforcement of the "one remote session per instance at a time" v1 ground
// rule (docs/adr/0002-remote-control.md R1; the vendored reference relay at
// vendor/oh-my-pi/packages/collab-web/scripts/local-relay.ts does NOT enforce
// this, which is exactly why mywayai ships its own relay instead of pointing
// at that script directly).
export const DEFAULT_MAX_GUESTS_PER_ROOM = 1;
