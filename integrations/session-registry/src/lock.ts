// Minimal cross-process exclusive lock for registry read-modify-write
// cycles, so two sessions heartbeating at the same instant can't interleave
// a partial write (docs/adr/0002-remote-control.md, "Registry file"). Same
// mkdir/O_EXCL-race-avoidance shape as omp's own
// packages/coding-agent/src/config/file-lock.ts (vendor/, never imported —
// reimplemented here so this package stays vendor-independent), scoped down
// to what the registry actually needs: acquire, detect staleness by pid
// liveness, retry with backoff, release.

import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface LockOptions {
  /** Total time to wait for the lock before giving up. */
  timeoutMs?: number;
  /** Delay between acquisition attempts. */
  retryDelayMs?: number;
  /** A lock older than this, held by a dead pid, is force-released. */
  staleMs?: number;
}

const DEFAULT_OPTIONS: Required<LockOptions> = {
  timeoutMs: 5_000,
  retryDelayMs: 50,
  staleMs: 15_000,
};

interface LockInfo {
  pid: number;
  token: string;
  acquiredAt: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLockInfo(lockPath: string): Promise<LockInfo | undefined> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8"));
    if (
      parsed &&
      typeof parsed.pid === "number" &&
      typeof parsed.token === "string" &&
      typeof parsed.acquiredAt === "number"
    ) {
      return parsed as LockInfo;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function isFileOlderThan(path: string, ms: number): Promise<boolean> {
  try {
    const info = await stat(path);
    return Date.now() - info.mtimeMs > ms;
  } catch {
    // Gone already (e.g. released between our EEXIST and this check) — not stale, just not there; the next link() attempt will succeed on its own.
    return false;
  }
}

async function clearStaleLock(lockPath: string, staleMs: number): Promise<void> {
  const info = await readLockInfo(lockPath);
  if (!info) {
    // Unreadable/corrupt/empty lock file. This can legitimately be a
    // still-being-written lock from a concurrent acquirer's link() (a tiny
    // window, but real) — only reap it once it's older than staleMs, never
    // on first sight, so we never delete a lock out from under its rightful
    // holder.
    const isStale = await isFileOlderThan(lockPath, staleMs);
    if (isStale) await rm(lockPath, { force: true });
    return;
  }
  if (!isProcessAlive(info.pid)) {
    await rm(lockPath, { force: true });
  }
}

/** Acquires the lock, retrying past contention and self-healing past a stale (dead-holder) lock. Returns a release function. */
export async function acquireLock(filePath: string, options: LockOptions = {}): Promise<() => Promise<void>> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const lockPath = `${filePath}.lock`;
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });

  const token = randomUUID();
  const deadline = Date.now() + opts.timeoutMs;

  while (true) {
    // Write full lock content to a private temp file, then atomically
    // create lockPath from it via link(): link() fails EEXIST if lockPath
    // already exists, and — unlike open(..., "wx") followed by a separate
    // write — there is no window where lockPath exists but is empty for a
    // concurrent acquirer to observe and reap as "abandoned".
    const tmpPath = `${lockPath}.tmp-${token}`;
    await writeFile(tmpPath, JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() }));
    try {
      await link(tmpPath, lockPath);
      await unlink(tmpPath).catch(() => {});
      return async () => {
        const current = await readLockInfo(lockPath);
        if (current?.token === token) await rm(lockPath, { force: true });
      };
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      await clearStaleLock(lockPath, opts.staleMs);
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for lock on ${filePath} after ${opts.timeoutMs}ms.`);
      }
      await Bun.sleep(opts.retryDelayMs);
    }
  }
}

/** Runs `fn` while holding the exclusive lock on `filePath`, releasing it afterward regardless of outcome. */
export async function withLock<T>(filePath: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const release = await acquireLock(filePath, options);
  try {
    return await fn();
  } finally {
    await release();
  }
}
