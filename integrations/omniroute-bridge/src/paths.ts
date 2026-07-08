// Filesystem locations the bridge reads/writes. Every path below honors env
// overrides so tests and profiles can redirect state without touching the
// real user directories.

import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));

/** Repository root — three levels up from `integrations/omniroute-bridge/src`. */
export function getRepoRoot(): string {
  return process.env.MYWAYAI_REPO_ROOT ?? resolve(moduleDir, "..", "..", "..");
}

export function getOmniRouteVendorDir(): string {
  return join(getRepoRoot(), "vendor", "omniroute");
}

/** Root for all mywayai runtime state (pidfile, logs, key, OmniRoute's DATA_DIR). */
export function getStateDir(): string {
  return process.env.MYWAYAI_STATE_DIR ?? join(homedir(), ".mywayai");
}

/** mkdirs the state dir and tightens it to 0700 even if it already existed looser (mkdir's mode is ignored on an existing dir). Call before every secret write. */
export async function ensureStateDir(): Promise<string> {
  const dir = getStateDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}

export function getOmniRouteDataDir(): string {
  return join(getStateDir(), "omniroute-data");
}

export function getLogDir(): string {
  return join(getStateDir(), "logs");
}

export function getDashboardLogFile(): string {
  return join(getLogDir(), "dashboard.log");
}

export function getDashboardPidFile(): string {
  return join(getStateDir(), "dashboard.pid");
}

export function getDashboardSecretFile(): string {
  return join(getStateDir(), "dashboard.secret");
}

export function getOmniRouteLogFile(): string {
  return join(getLogDir(), "omniroute.log");
}

export function getPidFile(): string {
  return join(getStateDir(), "omniroute.pid");
}

export function getKeyFile(): string {
  return join(getStateDir(), "omniroute.key");
}

export function getKeyIdFile(): string {
  return join(getStateDir(), "omniroute.key.id");
}

/** omp's agent config directory — respects `PI_CODING_AGENT_DIR` like omp itself. */
export function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
}

export function getModelsYamlPath(): string {
  return join(getAgentDir(), "models.yml");
}

export function getAgentConfigYamlPath(): string {
  return join(getAgentDir(), "config.yml");
}

export function getExtensionsDir(): string {
  return join(getAgentDir(), "extensions");
}

export const DEFAULT_OMNIROUTE_PORT = 20128;

/** Strict port validator: undefined/"" -> undefined; else requires an integer in [1, 65535], throwing an actionable error otherwise. Route every port parsed from env/argv through this. */
export function parsePort(value: string | undefined, label: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be an integer 1–65535`);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65_535) {
    throw new Error(`${label} must be an integer 1–65535`);
  }
  return n;
}

// A freshly-booted OmniRoute can be slow to answer its first authenticated
// request while it finishes heavy startup work (migrations, Arena Elo sync,
// etc.) even though it already accepts TCP connections — a short timeout on
// bootstrap calls (provisionKey/seedMock/writeRoleMapping) intermittently
// aborts a request that would have succeeded a few seconds later.
export const BOOTSTRAP_FETCH_TIMEOUT_MS = 20_000;

export function resolveOmniRoutePort(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  return parsePort(process.env.OMNIROUTE_PORT, "OMNIROUTE_PORT") ?? DEFAULT_OMNIROUTE_PORT;
}

export function omniRouteBaseUrl(port?: number): string {
  return `http://localhost:${resolveOmniRoutePort(port)}`;
}
