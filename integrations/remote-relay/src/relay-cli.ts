#!/usr/bin/env bun
// Foreground entry point spawned by server.ts's startRelay (stdio redirected
// to the relay log file, detached via proc.unref()). Not meant to be run
// interactively — use `remote-relay start` (cli.ts) or `mywayai relay up`
// (integrations/launcher) instead.

import type { RunningRelay } from "./relay-core.ts";
import { createRelay } from "./relay-core.ts";
import { DEFAULT_MAX_GUESTS_PER_ROOM, DEFAULT_RELAY_BIND, resolveRelayPort } from "./paths.ts";

function parseArgs(argv: string[]): { port?: number; bind?: string; maxGuestsPerRoom?: number } {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" || arg === "--bind" || arg === "--max-guests") flags[arg.slice(2)] = argv[++i] ?? "";
  }
  return {
    port: flags.port ? Number(flags.port) : undefined,
    bind: flags.bind,
    maxGuestsPerRoom: flags["max-guests"] ? Number(flags["max-guests"]) : undefined,
  };
}

function main(): RunningRelay {
  const parsed = parseArgs(Bun.argv.slice(2));
  const relay = createRelay({
    port: resolveRelayPort(parsed.port),
    bind: parsed.bind ?? DEFAULT_RELAY_BIND,
    maxGuestsPerRoom: parsed.maxGuestsPerRoom ?? DEFAULT_MAX_GUESTS_PER_ROOM,
  });
  console.log(`[${new Date().toISOString()}] remote-relay listening on ${relay.url} (max ${parsed.maxGuestsPerRoom ?? DEFAULT_MAX_GUESTS_PER_ROOM} guest/room)`);

  const shutdown = (signal: string): void => {
    console.log(`[${new Date().toISOString()}] remote-relay received ${signal}, stopping`);
    relay.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return relay;
}

if (import.meta.main) {
  main();
}
