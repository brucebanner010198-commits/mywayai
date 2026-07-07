// Relay process lifecycle: spawn/stop the relay (relay-cli.ts, which wraps
// relay-core.ts's createRelay) and probe liveness. Mirrors
// @mywayai/omniroute-bridge/src/server.ts's spawn+pidfile+poll shape, but
// simpler — this relay has no auth-required 401 case, so readiness is a
// plain HTTP 200 from /healthz.

import { openSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MAX_GUESTS_PER_ROOM,
  DEFAULT_RELAY_BIND,
  getRelayLogDir,
  getRelayLogFile,
  getRelayPidFile,
  getRelayStateDir,
  resolveRelayPort,
} from "./paths.ts";

const POLL_INTERVAL_MS = 300;
const PING_TIMEOUT_MS = 3_000;
const START_TIMEOUT_MS = 15_000;

const relayCliPath = fileURLToPath(new URL("./relay-cli.ts", import.meta.url));

async function pingOnce(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      keepalive: false,
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function isRelayUp(port?: number): Promise<boolean> {
  return pingOnce(resolveRelayPort(port));
}

async function readPid(): Promise<number | undefined> {
  try {
    const raw = (await readFile(getRelayPidFile(), "utf8")).trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface StartRelayOptions {
  port?: number;
  bind?: string;
  maxGuestsPerRoom?: number;
}

export interface StartedRelay {
  url: string;
  port: number;
}

export async function startRelay(opts: StartRelayOptions = {}): Promise<StartedRelay> {
  const port = resolveRelayPort(opts.port);
  const bind = opts.bind ?? process.env.MYWAYAI_RELAY_BIND ?? DEFAULT_RELAY_BIND;
  const maxGuestsPerRoom =
    opts.maxGuestsPerRoom ??
    (process.env.MYWAYAI_RELAY_MAX_GUESTS ? Number(process.env.MYWAYAI_RELAY_MAX_GUESTS) : DEFAULT_MAX_GUESTS_PER_ROOM);

  // Deliberately the opposite default posture from OmniRoute (docs/resilience-review.md
  // F1/H1): this relay's entire job is being reachable, so a narrow bind is
  // not "safe by default" here. What IS required is that binding wide is
  // never *silent* — the operator must say so once.
  if (bind !== "127.0.0.1" && bind !== "localhost" && process.env.MYWAYAI_RELAY_ACKNOWLEDGE_PUBLIC_BIND !== "1") {
    throw new Error(
      `Refusing to bind the relay to ${bind} (reachable beyond localhost) without an explicit ` +
        `acknowledgement. Set MYWAYAI_RELAY_ACKNOWLEDGE_PUBLIC_BIND=1 once this host is placed behind ` +
        `TLS and you intend it to be reachable (see docs/remote-control.md), or pass --bind 127.0.0.1 ` +
        `for local-only testing.`,
    );
  }

  if (await isRelayUp(port)) return { url: `ws://${bind}:${port}`, port };

  await mkdir(getRelayStateDir(), { recursive: true, mode: 0o700 });
  await mkdir(getRelayLogDir(), { recursive: true, mode: 0o700 });

  const logFd = openSync(getRelayLogFile(), "a");
  const proc = Bun.spawn({
    cmd: ["bun", relayCliPath, "--port", String(port), "--bind", bind, "--max-guests", String(maxGuestsPerRoom)],
    stdio: ["ignore", logFd, logFd],
  });
  proc.unref();
  await Bun.write(getRelayPidFile(), String(proc.pid));

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await pingOnce(port)) return { url: `ws://${bind}:${port}`, port };
    await Bun.sleep(POLL_INTERVAL_MS);
  }

  const tail = await readFile(getRelayLogFile(), "utf8").catch(() => "");
  throw new Error(
    `Relay did not become reachable on port ${port} within ${START_TIMEOUT_MS / 1000}s.\n` +
      `--- log tail (${getRelayLogFile()}) ---\n${tail.split("\n").slice(-40).join("\n")}`,
  );
}

export async function stopRelay(): Promise<void> {
  const pid = await readPid();
  if (pid === undefined) {
    console.error("remote-relay: no pidfile found — nothing to stop.");
    return;
  }
  if (!isProcessAlive(pid)) {
    console.error(`remote-relay: pid ${pid} is not running (stale pidfile) — removing it.`);
    await rm(getRelayPidFile(), { force: true });
    return;
  }
  process.kill(pid, "SIGTERM");
  await rm(getRelayPidFile(), { force: true });
}
