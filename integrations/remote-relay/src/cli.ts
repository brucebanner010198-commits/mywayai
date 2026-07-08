#!/usr/bin/env bun
// Thin CLI wrapping the relay lifecycle functions as subcommands, mirroring
// @mywayai/omniroute-bridge/src/cli.ts's shape. `integrations/launcher`
// composes startRelay/stopRelay/isRelayUp directly for `mywayai relay ...`
// rather than shelling out to this CLI.

import { isRelayUp, startRelay, stopRelay } from "./server.ts";
import { getRelayPidFile, resolveRelayPort } from "./paths.ts";

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg?.startsWith("--")) flags[arg.slice(2)] = args[++i] ?? "";
  }
  return flags;
}

function usage(): never {
  console.error(
    [
      "Usage: remote-relay <command> [options]",
      "",
      "Commands:",
      "  start [--port N] [--bind HOST] [--max-guests N]   Boot the relay if not already running",
      "  stop                                              Stop the managed relay process",
      "  status [--port N]                                 Print reachability and pid state",
    ].join("\n"),
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const port = flags.port ? Number(flags.port) : undefined;

  switch (command) {
    case "start":
      await startRelay({
        port,
        bind: flags.bind,
        maxGuestsPerRoom: flags["max-guests"] ? Number(flags["max-guests"]) : undefined,
      });
      return;
    case "stop":
      return stopRelay();
    case "status": {
      const up = await isRelayUp(port);
      console.log(`relay: ${up ? "up" : "down"} (port ${resolveRelayPort(port)})`);
      console.log(`pidfile: ${getRelayPidFile()}`);
      return;
    }
    default:
      usage();
  }
}

await main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
