// Upserts `modelRoles` entries in `~/.omp/agent/config.yml`, pointing omp
// model roles at OmniRoute combos (`omniroute/<combo-name>`).

import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import yaml from "js-yaml";
import { bootstrapFetch } from "./http.ts";
import { getAgentConfigYamlPath, omniRouteBaseUrl } from "./paths.ts";
import { requireKey } from "./keys.ts";

export const VALID_ROLE_IDS = [
  "default",
  "smol",
  "slow",
  "vision",
  "plan",
  "designer",
  "commit",
  "tiny",
  "task",
  "advisor",
] as const;

export type RoleId = (typeof VALID_ROLE_IDS)[number];

type YamlDoc = Record<string, unknown>;

async function loadYamlDoc(path: string): Promise<YamlDoc> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = yaml.load(raw);
    return parsed && typeof parsed === "object" ? (parsed as YamlDoc) : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

async function fetchExistingComboNames(port?: number): Promise<string[]> {
  const key = await requireKey();
  const res = await bootstrapFetch(`${omniRouteBaseUrl(port)}/api/combos`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`Failed to list OmniRoute combos: ${res.status}`);
  const data = (await res.json()) as { combos: Array<{ name: string }> };
  return data.combos.map((c) => c.name);
}

export interface WriteRoleMappingOptions {
  port?: number;
}

/**
 * @param map role id -> bare OmniRoute combo name (e.g. `{ default: "test-combo" }`).
 *   Combos are never auto-created here: a fresh install has no upstream
 *   providers to target, so users create combos in the dashboard or via
 *   `/omni combos create` first, then map roles to them.
 */
export async function writeRoleMapping(map: Record<string, string>, opts: WriteRoleMappingOptions = {}): Promise<void> {
  for (const role of Object.keys(map)) {
    if (!(VALID_ROLE_IDS as readonly string[]).includes(role)) {
      throw new Error(`Unknown omp model role "${role}". Valid roles: ${VALID_ROLE_IDS.join(", ")}`);
    }
  }

  const comboNames = await fetchExistingComboNames(opts.port);
  for (const [role, comboName] of Object.entries(map)) {
    if (!comboNames.includes(comboName)) {
      throw new Error(
        `Combo "${comboName}" (role "${role}") does not exist. Existing combos: ${comboNames.join(", ") || "(none)"}`,
      );
    }
  }

  const path = getAgentConfigYamlPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const doc = await loadYamlDoc(path);
  const modelRoles = (doc.modelRoles && typeof doc.modelRoles === "object" ? doc.modelRoles : {}) as Record<
    string,
    string
  >;
  for (const [role, comboName] of Object.entries(map)) {
    modelRoles[role] = `omniroute/${comboName}`;
  }
  doc.modelRoles = modelRoles;

  await Bun.write(path, yaml.dump(doc, { lineWidth: -1 }));
}
