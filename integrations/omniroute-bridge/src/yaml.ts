// Shared loader for the omp agent config documents the bridge upserts
// (models.yml, config.yml). A missing file yields an empty doc so callers can
// create it from scratch; any other read/parse error propagates.

import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import yaml from "js-yaml";

export type YamlDoc = Record<string, unknown>;

/** True for a plain object (not null, not an array) — the only shape a YAML doc's top level can be safely treated as a map. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function loadYamlDoc(path: string): Promise<YamlDoc> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = yaml.load(raw);
    return isPlainRecord(parsed) ? (parsed as YamlDoc) : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

/** Writes `contents` to `path` via temp-file-then-rename so a crash or concurrent writer mid-write never truncates the target — the user's real ~/.omp/agent config, which this module read-modify-writes. */
export async function atomicWriteFile(path: string, contents: string): Promise<void> {
  const tmp = `${path}.tmp-${randomUUID()}`;
  await writeFile(tmp, contents, { mode: 0o600 });
  await rename(tmp, path);
}
