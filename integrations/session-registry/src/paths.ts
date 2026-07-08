// Filesystem locations for the cross-session registry. Honors the same
// MYWAYAI_STATE_DIR override as integrations/omniroute-bridge/src/paths.ts
// so tests and profiles can redirect state without touching a real user's
// ~/.mywayai.

import { homedir } from "node:os";
import { join } from "node:path";

export function getStateDir(): string {
  return process.env.MYWAYAI_STATE_DIR ?? join(homedir(), ".mywayai");
}

export function getRegistryFile(): string {
  return join(getStateDir(), "sessions.json");
}

export function getRegistryLockFile(): string {
  return `${getRegistryFile()}.lock`;
}
