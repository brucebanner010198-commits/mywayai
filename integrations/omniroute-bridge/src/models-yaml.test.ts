// Verifies writeModelsYaml preserves unrelated keys and never produces a
// torn/corrupt models.yml under concurrent writers (Group E — atomicWriteFile
// via temp-file-then-rename, replacing a bare Bun.write that could truncate
// the user's whole omp config on a crash or race).

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import yaml from "js-yaml";
import { writeModelsYaml } from "./models-yaml.ts";

let agentDir: string;
let stateDir: string;

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "models-yaml-test-agent-"));
  stateDir = await mkdtemp(join(tmpdir(), "models-yaml-test-state-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.MYWAYAI_STATE_DIR = stateDir;
});

afterEach(async () => {
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.MYWAYAI_STATE_DIR;
  await rm(agentDir, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

test("writeModelsYaml preserves an unrelated providers block under concurrent writers, with no torn write", async () => {
  const modelsPath = join(agentDir, "models.yml");
  await writeFile(
    modelsPath,
    yaml.dump({ providers: { other: { baseUrl: "http://example.com", api: "openai-completions" } } }),
  );

  await Promise.all([writeModelsYaml(), writeModelsYaml()]);

  const raw = await readFile(modelsPath, "utf8");
  const doc = yaml.load(raw) as Record<string, unknown>;
  expect(doc).toBeTruthy();
  const providers = doc.providers as Record<string, unknown>;
  expect(providers.other).toBeTruthy();
  expect(providers.omniroute).toBeTruthy();
});
