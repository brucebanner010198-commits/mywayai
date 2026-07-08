// Filesystem locations the bridge reads/writes. Every path below honors env
// overrides so tests and profiles can redirect state without touching the
// real user directories.

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

// A freshly-booted OmniRoute can be slow to answer its first authenticated
// request while it finishes heavy startup work (migrations, Arena Elo sync,
// etc.) even though it already accepts TCP connections — a short timeout on
// bootstrap calls (provisionKey/seedMock/writeRoleMapping) intermittently
// aborts a request that would have succeeded a few seconds later.
export const BOOTSTRAP_FETCH_TIMEOUT_MS = 20_000;

export function resolveOmniRoutePort(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const fromEnv = process.env.OMNIROUTE_PORT;
  return fromEnv ? Number(fromEnv) : DEFAULT_OMNIROUTE_PORT;
}

export function omniRouteBaseUrl(port?: number): string {
  return `http://localhost:${resolveOmniRoutePort(port)}`;
}
