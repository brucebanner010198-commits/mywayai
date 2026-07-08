// A registered, remotely-reachable session. `link` is a full `/collab`
// write-capable link — an RCE-capable credential, same class as an API key
// (docs/adr/0002-remote-control.md, "Registry file"). Never log it; the
// dashboard renders it only as an `<a href>`.
export interface SessionEntry {
  /** Stable per-session id (generated once, at first registration). */
  id: string;
  /** Human-chosen or auto-derived display name. */
  name: string;
  /** The hosting session's working directory. */
  cwd: string;
  /** Full `/collab` link (write-capable). */
  link: string;
  /** ISO-8601 timestamp of the last heartbeat/registration write. */
  lastActiveAt: string;
  /** PID of the hosting omp process — liveness check for pruning. */
  pid: number;
}
