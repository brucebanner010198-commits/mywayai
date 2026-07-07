// OmniRoute server lifecycle: spawn/stop the vendored Next.js app and probe
// liveness.
//
// Readiness correction (verified live, 2026-07-07): OmniRoute ships
// `INITIAL_PASSWORD=CHANGEME` in `.env.example`, which `npm ci`'s postinstall
// copies into `vendor/omniroute/.env`. That makes `isAuthRequired()` return
// `true` from the very first boot, so `GET /api/health/ping` answers 401
// (not 200) until a caller is authenticated — even though the route's own
// code has no auth check (a higher-level management-auth gate intercepts
// first). Waiting for exactly HTTP 200 would hang forever on a fresh
// install. Readiness therefore means "the port answered an HTTP response at
// all" (200 once authenticated, 401 pre-auth) — only a connection failure
// means the server isn't up yet.

import { openSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import {
  getLogDir,
  getOmniRouteDataDir,
  getOmniRouteLogFile,
  getOmniRouteVendorDir,
  getPidFile,
  getStateDir,
  omniRouteBaseUrl,
  resolveOmniRoutePort,
} from "./paths.ts";

const POLL_INTERVAL_MS = 500;
// Generous: a fresh install's first boot does synchronous MDX generation,
// Arena Elo sync, and 100+ migrations that can briefly block the event loop
// long enough for a tight per-request timeout to abort a response that was
// actually on its way (observed live: attempts failing every poll for the
// full window even though the server had already logged "start server
// listening").
const PING_TIMEOUT_MS = 8_000;
const START_TIMEOUT_MS = 120_000;
const INITIAL_GRACE_MS = 8_000;

async function pingOnce(port: number): Promise<boolean> {
  try {
    const res = await fetch(`${omniRouteBaseUrl(port)}/api/health/ping`, {
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      // Bun's fetch connection-pooling reuses keep-alive connections across
      // calls from the same process; reusing one against this server hangs
      // indefinitely (observed live) even though the server itself answers
      // instantly on a fresh connection. Force a fresh connection per call.
      keepalive: false,
    });
    // 200 = healthy; 401 = alive but unauthenticated. Both prove the process
    // is up and accepting connections; only a network-level failure means down.
    return res.status === 200 || res.status === 401;
  } catch {
    return false;
  }
}

export async function isUp(port?: number): Promise<boolean> {
  return pingOnce(resolveOmniRoutePort(port));
}

async function readPid(): Promise<number | undefined> {
  try {
    const raw = (await readFile(getPidFile(), "utf8")).trim();
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

export interface StartOmniRouteOptions {
  port?: number;
  /** Directory to prepend to PATH for the spawned npm/node (e.g. a keg-only node@24 install). */
  nodeBinDir?: string;
}

export async function startOmniRoute(opts: StartOmniRouteOptions = {}): Promise<void> {
  const port = resolveOmniRoutePort(opts.port);

  if (await isUp(port)) {
    return; // Reuse the already-running server instead of double-spawning.
  }

  await mkdir(getStateDir(), { recursive: true, mode: 0o700 });
  await mkdir(getLogDir(), { recursive: true, mode: 0o700 });
  await mkdir(getOmniRouteDataDir(), { recursive: true, mode: 0o700 });

  const nodeBinDir = opts.nodeBinDir ?? process.env.MYWAYAI_NODE_BIN_DIR;
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PORT: String(port),
    DATA_DIR: getOmniRouteDataDir(),
  };
  if (nodeBinDir) {
    env.PATH = `${nodeBinDir}:${process.env.PATH ?? ""}`;
  }

  const logFd = openSync(getOmniRouteLogFile(), "a");
  const proc = Bun.spawn({
    cmd: ["npm", "run", "start"],
    cwd: getOmniRouteVendorDir(),
    env,
    stdio: ["ignore", logFd, logFd],
  });
  proc.unref();
  await Bun.write(getPidFile(), String(proc.pid));

  // Grace period before the first poll: an HTTP request that lands while
  // Next.js's custom server is mid-bootstrap (before it logs "start server
  // listening" and finishes its first-request lazy compilation) can wedge
  // the whole process — observed live: hammering `/api/health/ping` within
  // the first ~1-2s of the child's life reliably left it accepting TCP
  // connections but never completing a single HTTP response, indefinitely.
  // Waiting before the first request avoids the race entirely.
  await Bun.sleep(INITIAL_GRACE_MS);

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await pingOnce(port)) return;
    await Bun.sleep(POLL_INTERVAL_MS);
  }

  const tail = await readFile(getOmniRouteLogFile(), "utf8").catch(() => "");
  throw new Error(
    `OmniRoute did not become reachable on port ${port} within ${START_TIMEOUT_MS / 1000}s.\n` +
      `--- log tail (${getOmniRouteLogFile()}) ---\n${tail.split("\n").slice(-40).join("\n")}`,
  );
}

export async function stopOmniRoute(): Promise<void> {
  const pid = await readPid();
  if (pid === undefined) {
    console.error("mywayai: no OmniRoute pidfile found — nothing to stop.");
    return;
  }
  if (!isProcessAlive(pid)) {
    console.error(`mywayai: OmniRoute pid ${pid} is not running (stale pidfile) — removing it.`);
    await rm(getPidFile(), { force: true });
    return;
  }
  process.kill(pid, "SIGTERM");
  await rm(getPidFile(), { force: true });
}
