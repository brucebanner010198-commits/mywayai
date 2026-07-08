export type { SessionEntry } from "./types.ts";
export {
  clearRegistry,
  isEntryAlive,
  pruneRegistry,
  readLiveRegistry,
  readRegistry,
  removeRegistryEntry,
  upsertRegistryEntry,
} from "./registry.ts";
export { getRegistryFile, getRegistryLockFile, getStateDir } from "./paths.ts";
export { acquireLock, withLock } from "./lock.ts";

/** Suggested re-write interval for heartbeat writers (docs/adr/0002-remote-control.md, "Design"). */
export const REGISTRY_HEARTBEAT_MS = 30_000;
