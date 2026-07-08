#!/usr/bin/env bun
// Thin CLI wrapping every bridge function as a subcommand, for manual use
// and shell scripting. The launcher (integrations/launcher) composes these
// functions directly rather than shelling out to this CLI.

import { isUp, provisionKey, readKeyFile, rotateKey, seedMock, startOmniRoute, stopOmniRoute } from "./index.ts";
import { writeModelsYaml } from "./models-yaml.ts";
import { writeRoleMapping } from "./roles.ts";
import { getKeyFile, getPidFile, resolveOmniRoutePort } from "./paths.ts";

const BOOLEAN_FLAGS: Record<string, true> = { "print-key": true };

function parseFlags(args: string[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg?.startsWith("--")) {
      const name = arg.slice(2);
      flags[name] = BOOLEAN_FLAGS[name] ? "true" : args[++i] ?? "";
    } else if (arg !== undefined) {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function usage(): never {
  console.error(
    [
      "Usage: omniroute-bridge <command> [options]",
      "",
      "Commands:",
      "  start [--port N] [--node-bin-dir DIR]   Boot OmniRoute if not already running",
      "  stop                                    Stop the managed OmniRoute process",
      "  status [--port N]                       Print reachability, pid, and key-file state",
      "  provision-key [--port N] [--print-key]   Mint/reuse the manage-scope API key",
      "  rotate-key [--port N] [--print-key]      Regenerate the API key",
      "  seed-mock [--port N] [--mock-port N]     Seed the mock provider/connection/combo",
      "  write-models [--port N]                 Upsert the omniroute provider in models.yml",
      "  write-roles <role>=<combo> ... [--port N]  Map omp roles to OmniRoute combos in config.yml",
    ].join("\n"),
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { positionals, flags } = parseFlags(rest);
  const port = flags.port ? Number(flags.port) : undefined;

  switch (command) {
    case "start":
      await startOmniRoute({ port, nodeBinDir: flags["node-bin-dir"] });
      console.log(`OmniRoute is up on port ${resolveOmniRoutePort(port)}.`);
      return;

    case "stop":
      await stopOmniRoute();
      return;

    case "status": {
      const up = await isUp(port);
      const key = await readKeyFile();
      console.log(`reachable: ${up}`);
      console.log(`pidfile:   ${getPidFile()}`);
      console.log(`keyfile:   ${getKeyFile()} (${key ? "present" : "absent"})`);
      return;
    }

    case "provision-key": {
      const key = await provisionKey({ port });
      console.log(flags["print-key"] ? key : `Wrote manage-scope key to ${getKeyFile()}`);
      return;
    }

    case "rotate-key": {
      const key = await rotateKey({ port });
      console.log(flags["print-key"] ? key : `Wrote manage-scope key to ${getKeyFile()}`);
      return;
    }

    case "seed-mock":
      await seedMock({ port, mockPort: flags["mock-port"] ? Number(flags["mock-port"]) : undefined });
      console.log("Seeded mock provider, connection, and test-combo.");
      return;

    case "write-models":
      await writeModelsYaml({ port });
      console.log("Wrote providers.omniroute to models.yml.");
      return;

    case "write-roles": {
      if (positionals.length === 0) usage();
      const map: Record<string, string> = {};
      for (const pair of positionals) {
        const [role, combo] = pair.split("=");
        if (!role || !combo) usage();
        map[role] = combo;
      }
      await writeRoleMapping(map, { port });
      console.log(`Wrote role mapping: ${JSON.stringify(map)}`);
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
