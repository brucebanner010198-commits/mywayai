// Read/write path for ~/.mywayai/sessions.json — the local, phone-reachable
// session index described in docs/adr/0002-remote-control.md. Hard
// requirements from that ADR, all implemented here: 0600/0700 permissions,
// atomic writes (temp file + rename), a liveness-checked prune pass, and
// serialization across concurrent writers via lock.ts.

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { withLock } from "./lock.ts";
import { getRegistryFile, getStateDir } from "./paths.ts";
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
  if (Number.isFinite(lastActive) && Date.now() - lastActive > STALE_AFTER_MS) return false;
  try {
    process.kill(entry.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isValidEntry(value: unknown): value is SessionEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.name === "string" &&
    typeof e.cwd === "string" &&
    typeof e.link === "string" &&
    typeof e.lastActiveAt === "string" &&
    typeof e.pid === "number"
  );
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
    return Array.isArray(parsed) ? parsed.filter(isValidEntry) : [];
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
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${randomUUID()}`;
  await Bun.write(tmp, JSON.stringify(entries, null, 2));
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

/** Upserts one entry (matched by `id`) and prunes dead entries in the same locked, atomic write. Used by a session's start and periodic heartbeat. */
export async function upsertRegistryEntry(entry: SessionEntry): Promise<SessionEntry[]> {
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
