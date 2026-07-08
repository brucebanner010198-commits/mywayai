export { createRelay, type RelayOptions, type RunningRelay } from "./relay-core.ts";
export { isRelayUp, startRelay, stopRelay, type StartedRelay, type StartRelayOptions } from "./server.ts";
export {
  DEFAULT_MAX_GUESTS_PER_ROOM,
  DEFAULT_RELAY_BIND,
  DEFAULT_RELAY_PORT,
  getRelayLogFile,
  getRelayPidFile,
  getRelayStateDir,
  resolveRelayPort,
} from "./paths.ts";
