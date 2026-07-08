// Upserts the `collab.*` block in `~/.omp/agent/config.yml`, pointing omp's
// built-in `/collab` (vendor/oh-my-pi/docs/collab.md) at the operator's
// self-hosted relay (@mywayai/remote-relay) instead of the default
// `wss://my.omp.sh` — see docs/adr/0002-remote-control.md for why mywayai
// never defaults to the public relay. Same idempotent load-merge-write shape
// as writeModelsYaml/writeRoleMapping.

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import yaml from "js-yaml";
import { getAgentConfigYamlPath } from "./paths.ts";
import { loadYamlDoc, type YamlDoc } from "./yaml.ts";

export interface WriteCollabConfigOptions {
  /** e.g. "wss://relay.example.com:8787" or "ws://127.0.0.1:8787" for local-only testing. */
  relayUrl: string;
  /** Name shown to other collab participants. Defaults to the OS username, same as omp's own default. */
  displayName?: string;
}

export async function writeCollabConfig(opts: WriteCollabConfigOptions): Promise<void> {
  if (!/^wss?:\/\//.test(opts.relayUrl)) {
    throw new Error(`collab relay URL must start with ws:// or wss:// — got "${opts.relayUrl}"`);
  }

  const path = getAgentConfigYamlPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const doc = await loadYamlDoc(path);
  const collab = (doc.collab && typeof doc.collab === "object" ? doc.collab : {}) as YamlDoc;
  collab.relayUrl = opts.relayUrl;
  if (opts.displayName) collab.displayName = opts.displayName;
  doc.collab = collab;

  await Bun.write(path, yaml.dump(doc, { lineWidth: -1 }));
}

/** Reads the currently-configured `collab.relayUrl`, or `undefined` if unset/unwritten. */
export async function readCollabRelayUrl(): Promise<string | undefined> {
  const doc = await loadYamlDoc(getAgentConfigYamlPath());
  const collab = doc.collab && typeof doc.collab === "object" ? (doc.collab as YamlDoc) : {};
  return typeof collab.relayUrl === "string" ? collab.relayUrl : undefined;
}
