// Read/write path for ~/.mywayai/sessions.json — the local, phone-reachable
// session index described in docs/adr/0002-remote-control.md. Hard
// requirements from that ADR, all implemented here: 0600/0700 permissions,
// atomic writes (temp file + rename), a liveness-checked prune pass, and
// serialization across concurrent writers via lock.ts.

import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { withLock } from "./lock.ts";
import { ensureStateDir, getRegistryFile, getStateDir } from "./paths.ts";
import type { SessionEntry } from "./types.ts";

// A recycled pid (common over a long-running machine's uptime) would
// otherwise let a dead session's registry entry — an RCE-capable link —
// look "alive" forever by pid check alone. A live session heartbeats every
// REGISTRY_HEARTBEAT_MS (index.ts); three missed intervals is a safe margin
// past normal scheduling jitter without falsely killing a slow-heartbeat
// entry.
const STALE_AFTER_MS = 3 * 30_000;

/** True if the entry's hosting process is confirmed alive AND has heartbeated recently. Safe to call without holding the lock — used for lock-free display-time filtering (see dashboard). */
export function isEntryAlive(entry: SessionEntry): boolean {
  if (!Number.isFinite(entry.pid) || entry.pid <= 0) return false;
  const lastActive = Date.parse(entry.lastActiveAt);
  if (!Number.isFinite(lastActive)) return false;
  if (lastActive - Date.now() > 60_000) return false;
  if (Date.now() - lastActive > STALE_AFTER_MS) return false;
  try {
    process.kill(entry.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseIPv4Octets(host: string): number[] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const n = Number(part);
    if (n < 0 || n > 255 || String(n) !== part) return undefined;
    octets.push(n);
  }
  return octets;
}

// 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 — RFC 1918 private ranges.
function isRfc1918(host: string): boolean {
  const octets = parseIPv4Octets(host);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

// 100.64.0.0/10 — Tailscale's CGNAT tailnet address range.
function isTailscaleCgnat(host: string): boolean {
  const octets = parseIPv4Octets(host);
  if (!octets) return false;
  const [a, b] = octets;
  return a === 100 && b >= 64 && b <= 127;
}

/** True for an https(s) link on any host, or an http(s) link on localhost/RFC1918/Tailscale — the only hosts an omp `/collab` link legitimately targets (LAN/tailnet URLs). Rejects everything else, including `javascript:` and other non-http(s) schemes. */
export function isAllowedCollabUrl(link: string): boolean {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  if (u.protocol !== "http:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  return isRfc1918(host) || isTailscaleCgnat(host);
}

const SESSION_ID_PATTERN = /^[\w-]{1,64}$/;

function maskLink(link: string): string {
  return link.length <= 8 ? "…" : `${link.slice(0, 8)}…`;
}

/** Validates a session entry at the trust boundary (persisted from an untrusted `/remote register` call or a hand-edited sessions.json): shape, size caps, and a scheme-checked RCE-capable `link`. */
export function validateSessionEntry(value: unknown): value is SessionEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  if (typeof e.id !== "string" || !SESSION_ID_PATTERN.test(e.id)) return false;
  if (typeof e.name !== "string" || e.name.length > 256) return false;
  if (typeof e.cwd !== "string" || e.cwd.length > 4096) return false;
  if (typeof e.pid !== "number" || !Number.isSafeInteger(e.pid) || e.pid <= 0) return false;
  if (typeof e.lastActiveAt !== "string") return false;
  const lastActive = Date.parse(e.lastActiveAt);
  if (!Number.isFinite(lastActive) || lastActive > Date.now() + 60_000) return false;
  if (typeof e.link !== "string" || e.link.length > 8192 || !isAllowedCollabUrl(e.link)) return false;
  return true;
}

/**
 * Reads the registry as-is, without pruning or locking — cheap for frequent
 * callers (e.g. the dashboard's list page). Corrupt or missing files read as
 * empty; the next heartbeat/registration self-heals the file (per the ADR,
 * this is a deliberate design, not a swallowed error).
 */
export async function readRegistry(): Promise<SessionEntry[]> {
  let raw: string;
  try {
    raw = await readFile(getRegistryFile(), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(validateSessionEntry) : [];
  } catch {
    return [];
  }
}

/** Registry entries whose hosting process is confirmed alive, without persisting a prune. */
export async function readLiveRegistry(): Promise<SessionEntry[]> {
  return (await readRegistry()).filter(isEntryAlive);
}

async function atomicWrite(entries: SessionEntry[]): Promise<void> {
  const file = getRegistryFile();
  await ensureStateDir();
  const tmp = `${file}.tmp-${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(entries, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}

/** Upserts one entry (matched by `id`) and prunes dead entries in the same locked, atomic write. Used by a session's start and periodic heartbeat. */
export async function upsertRegistryEntry(entry: SessionEntry): Promise<SessionEntry[]> {
  const rawLink = entry.link;
  if (!validateSessionEntry(entry)) {
    throw new Error(`Refusing to store invalid session entry: ${maskLink(rawLink)}`);
  }
  return withLock(getRegistryFile(), async () => {
    const current = (await readRegistry()).filter(isEntryAlive);
    const idx = current.findIndex((e) => e.id === entry.id);
    if (idx >= 0) current[idx] = entry;
    else current.push(entry);
    await atomicWrite(current);
    return current;
  });
}

/** Removes one entry by id (graceful `/collab stop` / session shutdown). Also prunes any other dead entries found in the same pass. */
export async function removeRegistryEntry(id: string): Promise<SessionEntry[]> {
  return withLock(getRegistryFile(), async () => {
    const current = (await readRegistry()).filter((e) => e.id !== id && isEntryAlive(e));
    await atomicWrite(current);
    return current;
  });
}

/** Explicit prune pass with no upsert — drops entries whose pid is no longer alive. */
export async function pruneRegistry(): Promise<SessionEntry[]> {
  return withLock(getRegistryFile(), async () => {
    const current = (await readRegistry()).filter(isEntryAlive);
    await atomicWrite(current);
    return current;
  });
}

/** Removes the registry file and its lock entirely (e.g. test teardown, `mywayai dashboard reset`). */
export async function clearRegistry(): Promise<void> {
  await rm(getRegistryFile(), { force: true });
  await rm(`${getRegistryFile()}.lock`, { force: true });
}

export { getRegistryFile, getStateDir };
