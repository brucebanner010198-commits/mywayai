// Shared loader for the omp agent config documents the bridge upserts
// (models.yml, config.yml). A missing file yields an empty doc so callers can
// create it from scratch; any other read/parse error propagates.

import { readFile } from "node:fs/promises";
import yaml from "js-yaml";

export type YamlDoc = Record<string, unknown>;

export async function loadYamlDoc(path: string): Promise<YamlDoc> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = yaml.load(raw);
    return parsed && typeof parsed === "object" ? (parsed as YamlDoc) : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}
