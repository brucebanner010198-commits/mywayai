// Upserts the `providers.omniroute` block in `~/.omp/agent/models.yml`,
// preserving every other key. Idempotent: running twice yields byte-identical
// output (js-yaml preserves key insertion order and quotes the `!cat ...`
// apiKey value correctly, so it round-trips without omp's "!command" secret
// syntax being misread as a YAML tag).

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import yaml from "js-yaml";
import { getKeyFile, getModelsYamlPath, omniRouteBaseUrl } from "./paths.ts";
import { loadYamlDoc, type YamlDoc } from "./yaml.ts";

export interface WriteModelsYamlOptions {
  port?: number;
}

export async function writeModelsYaml(opts: WriteModelsYamlOptions = {}): Promise<void> {
  const path = getModelsYamlPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const doc = await loadYamlDoc(path);
  const providers = (doc.providers && typeof doc.providers === "object" ? doc.providers : {}) as YamlDoc;

  // REQUIRED: OmniRoute's `/api/v1/models` catalog reports `supported_endpoints`
  // (not omp's expected `supported_endpoint_types`), so omp's proxy discovery
  // never finds a per-model wire type and falls back to this provider-level
  // `api`. Without it, every discovered model is silently dropped.
  providers.omniroute = {
    baseUrl: `${omniRouteBaseUrl(opts.port)}/api/v1`,
    api: "openai-completions",
    apiKey: `!cat ${getKeyFile()}`,
    discovery: { type: "proxy" },
  };
  doc.providers = providers;

  await Bun.write(path, yaml.dump(doc, { lineWidth: -1 }));
}
