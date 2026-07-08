// Filesystem locations for the cross-session registry. Honors the same
// MYWAYAI_STATE_DIR override as integrations/omniroute-bridge/src/paths.ts
// so tests and profiles can redirect state without touching a real user's
// ~/.mywayai.

import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function getStateDir(): string {
  return process.env.MYWAYAI_STATE_DIR ?? join(homedir(), ".mywayai");
}

/** mkdirs the state dir and tightens it to 0700 even if it already existed looser (mkdir's mode is ignored on an existing dir). Local twin of omniroute-bridge's ensureStateDir — this package stays vendor/workspace-independent. */
export async function ensureStateDir(): Promise<string> {
  const dir = getStateDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}

export function getRegistryFile(): string {
  return join(getStateDir(), "sessions.json");
}

export function getRegistryLockFile(): string {
  return `${getRegistryFile()}.lock`;
}
