#!/usr/bin/env bun
// `mywayai` CLI — composes the omniroute-bridge functions into the day-to-day
// developer workflow: build/boot OmniRoute, provision it, wire omp's
// models.yml + extension, then exec the pinned omp binary.
//
// Remote Control (docs/adr/0002-remote-control.md) adds three things here:
//   - `up`/`daemon up --remote [--relay <url>] [--name <n>]`: write
//     collab.relayUrl into config.yml and set MYWAYAI_REMOTE=1 so the omp
//     extension (omp-omniroute-extension) auto-starts /collab.
//   - `relay up/down/status/logs`: lifecycle for the self-hosted relay
//     (@mywayai/remote-relay) — normally run on a *different host* from
//     this one; see docs/remote-control.md.
//   - `daemon up/down/status/logs`: EXPERIMENTAL headless `omp --mode rpc`
//     alternative to the default interactive `up` (see daemon.ts and the
//     ADR's "Open question" section for what is and isn't verified here).

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getExtensionsDir,
  getOmniRouteLogFile,
  getOmniRouteVendorDir,
  getPidFile,
  getRepoRoot,
  isUp,
  provisionKey,
  readCollabRelayUrl,
  readKeyFile,
  resolveOmniRoutePort,
  seedMock,
  startOmniRoute,
  stopOmniRoute,
  writeCollabConfig,
  writeModelsYaml,
} from "@mywayai/omniroute-bridge";
import {
  getRelayLogFile,
  getRelayPidFile,
  isRelayUp,
  resolveRelayPort,
  startRelay,
  stopRelay,
} from "@mywayai/remote-relay";
import { getDaemonLogFile, getDaemonPidFile, isDaemonUp, startDaemon, stopDaemon } from "./daemon.ts";

const launcherRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

interface ParsedArgs {
  flags: Record<string, string | boolean>;
  passthrough: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const sepIndex = argv.indexOf("--");
  const own = sepIndex === -1 ? argv : argv.slice(0, sepIndex);
  const passthrough = sepIndex === -1 ? [] : argv.slice(sepIndex + 1);

  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < own.length; i++) {
    const arg = own[i];
    if (arg === "--seed-mock") flags["seed-mock"] = true;
    else if (arg === "--port") flags.port = own[++i] ?? "";
    else if (arg === "-f" || arg === "--follow") flags.follow = true;
    else if (arg === "--remote") flags.remote = true;
    else if (arg === "--relay") flags.relay = own[++i] ?? "";
    else if (arg === "--name") flags.name = own[++i] ?? "";
    else if (arg === "--bind") flags.bind = own[++i] ?? "";
    else if (arg === "--max-guests") flags["max-guests"] = own[++i] ?? "";
  }
  return { flags, passthrough };
}

async function runInherited(cmd: string[], cwd?: string, env?: Record<string, string>): Promise<number> {
  const proc = Bun.spawn({ cmd, cwd, env: env ?? (process.env as Record<string, string>), stdio: ["inherit", "inherit", "inherit"] });
  return proc.exited;
}

async function ensureOmniRouteBuilt(nodeBinDir: string | undefined): Promise<void> {
  const marker = join(getOmniRouteVendorDir(), ".build", "next", "standalone");
  if (existsSync(marker)) return;

  console.log("OmniRoute is not built yet — building now (this can take several minutes)...");
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (nodeBinDir) env.PATH = `${nodeBinDir}:${process.env.PATH ?? ""}`;

  const ciCode = await runInherited(["npm", "ci"], getOmniRouteVendorDir(), env);
  if (ciCode !== 0) throw new Error("`npm ci` failed in vendor/omniroute.");

  const buildCode = await runInherited(
    ["npm", "run", "build"],
    getOmniRouteVendorDir(),
    { ...env, NODE_OPTIONS: "--max-old-space-size=4096" },
  );
  if (buildCode !== 0) throw new Error("`npm run build` failed in vendor/omniroute.");
}

async function ensureExtensionInstalled(): Promise<void> {
  const extPkgDir = join(getRepoRoot(), "integrations", "omp-omniroute-extension");
  const distFile = join(extPkgDir, "dist", "omniroute.js");

  if (!existsSync(distFile)) {
    console.log("Building the omp extension...");
    const code = await runInherited(
      ["bun", "build", "src/extension.ts", "--target=bun", "--outfile=dist/omniroute.js"],
      extPkgDir,
    );
    if (code !== 0) throw new Error("Failed to build the omp extension.");
  }

  await mkdir(getExtensionsDir(), { recursive: true, mode: 0o700 });
  await cp(distFile, join(getExtensionsDir(), "omniroute.js"));
}

/** Resolves the relay URL an operator wants `up`/`daemon up --remote` to use: the explicit `--relay` flag, else
 *  whatever is already configured (a previous `--relay` run, or manual `/collab <relay>` usage). Never falls back
 *  to the public wss://my.omp.sh default (docs/adr/0002-remote-control.md) — mywayai requires an explicit opt-in. */
async function resolveRemoteRelayUrl(explicitRelay: string | boolean | undefined): Promise<string> {
  if (typeof explicitRelay === "string" && explicitRelay) return explicitRelay;
  const existing = await readCollabRelayUrl();
  if (existing) return existing;
  throw new Error(
    "--remote requires a relay URL: pass --relay wss://<host>:<port> (boot one with `mywayai relay up` on a " +
      "separate host — see docs/remote-control.md), or configure collab.relayUrl in ~/.omp/agent/config.yml " +
      "first. mywayai never defaults to the public wss://my.omp.sh relay (docs/adr/0002-remote-control.md).",
  );
}

/** Shared OmniRoute boot sequence used by both `up` and `daemon up`. */
async function bootOmniRouteAndExtension(flags: ParsedArgs["flags"]): Promise<{ port: number | undefined }> {
  const port = flags.port ? Number(flags.port) : undefined;
  const nodeBinDir = process.env.MYWAYAI_NODE_BIN_DIR;

  await ensureOmniRouteBuilt(nodeBinDir);
  await startOmniRoute({ port, nodeBinDir });
  await provisionKey({ port });
  if (flags["seed-mock"]) await seedMock({ port });
  await writeModelsYaml({ port });
  await ensureExtensionInstalled();

  return { port };
}

/** Shared env/config wiring for the omp process both `up` and `daemon up` eventually spawn: session naming
 *  (--name) and, when --remote is set, writing collab.relayUrl and MYWAYAI_REMOTE=1 (read by the extension's
 *  session_start handler to auto-run /collab — see docs/adr/0002-remote-control.md R3). */
async function buildSessionEnv(flags: ParsedArgs["flags"], port: number | undefined): Promise<{ env: Record<string, string>; remote: boolean }> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), OMNIROUTE_PORT: String(resolveOmniRoutePort(port)) };
  if (typeof flags.name === "string" && flags.name) env.MYWAYAI_SESSION_NAME = flags.name;

  const remote = Boolean(flags.remote);
  if (remote) {
    const relayUrl = await resolveRemoteRelayUrl(flags.relay);
    await writeCollabConfig({ relayUrl });
    env.MYWAYAI_REMOTE = "1";
  }
  return { env, remote };
}

async function cmdUp({ flags, passthrough }: ParsedArgs): Promise<void> {
  const { port } = await bootOmniRouteAndExtension(flags);
  const { env } = await buildSessionEnv(flags, port);

  const ompBin = join(launcherRoot, "node_modules", ".bin", "omp");
  const code = await runInherited([ompBin, ...passthrough], undefined, env);
  process.exit(code);
}

async function cmdDown(): Promise<void> {
  await stopOmniRoute();
}

async function cmdStatus({ flags }: ParsedArgs): Promise<void> {
  const port = flags.port ? Number(flags.port) : undefined;
  const up = await isUp(port);
  const key = await readKeyFile();
  console.log(`OmniRoute: ${up ? "up" : "down"} (port ${resolveOmniRoutePort(port)})`);
  console.log(`pidfile:   ${getPidFile()}`);
  console.log(`key file:  ${key ? "present" : "absent"}`);
}

async function cmdLogs({ flags }: ParsedArgs): Promise<void> {
  const logFile = getOmniRouteLogFile();
  if (flags.follow) {
    process.exit(await runInherited(["tail", "-f", logFile]));
  }
  console.log(await readFile(logFile, "utf8").catch(() => "(no log file yet)"));
}

async function cmdSync(): Promise<void> {
  process.exit(await runInherited([join(getRepoRoot(), "scripts", "subtree-pull.sh")]));
}

async function cmdRelayUp(flags: ParsedArgs["flags"]): Promise<void> {
  const started = await startRelay({
    port: flags.port ? Number(flags.port) : undefined,
    bind: typeof flags.bind === "string" ? flags.bind : undefined,
    maxGuestsPerRoom: flags["max-guests"] ? Number(flags["max-guests"]) : undefined,
  });
  console.log(`relay: up at ${started.url}`);
}

async function cmdRelayStatus(flags: ParsedArgs["flags"]): Promise<void> {
  const port = flags.port ? Number(flags.port) : undefined;
  const up = await isRelayUp(port);
  console.log(`relay: ${up ? "up" : "down"} (port ${resolveRelayPort(port)})`);
  console.log(`pidfile: ${getRelayPidFile()}`);
}

async function cmdRelayLogs(flags: ParsedArgs["flags"]): Promise<void> {
  const logFile = getRelayLogFile();
  if (flags.follow) {
    process.exit(await runInherited(["tail", "-f", logFile]));
  }
  console.log(await readFile(logFile, "utf8").catch(() => "(no log file yet)"));
}

async function dispatchRelay(sub: string | undefined, parsed: ParsedArgs): Promise<void> {
  switch (sub) {
    case "up":
      return cmdRelayUp(parsed.flags);
    case "down":
      return stopRelay();
    case "status":
      return cmdRelayStatus(parsed.flags);
    case "logs":
      return cmdRelayLogs(parsed.flags);
    default:
      usage();
  }
}

async function cmdDaemonUp({ flags, passthrough }: ParsedArgs): Promise<void> {
  const { port } = await bootOmniRouteAndExtension(flags);
  const { env, remote } = await buildSessionEnv(flags, port);

  const ompBin = join(launcherRoot, "node_modules", ".bin", "omp");
  await startDaemon({ ompBin, passthrough, env, remote });
}

async function cmdDaemonStatus(): Promise<void> {
  const up = await isDaemonUp();
  console.log(`daemon: ${up ? "up" : "down"}`);
  console.log(`pidfile: ${getDaemonPidFile()}`);
}

async function cmdDaemonLogs(flags: ParsedArgs["flags"]): Promise<void> {
  const logFile = getDaemonLogFile();
  if (flags.follow) {
    process.exit(await runInherited(["tail", "-f", logFile]));
  }
  console.log(await readFile(logFile, "utf8").catch(() => "(no log file yet)"));
}

async function dispatchDaemon(sub: string | undefined, parsed: ParsedArgs): Promise<void> {
  switch (sub) {
    case "up":
      return cmdDaemonUp(parsed);
    case "down":
      return stopDaemon();
    case "status":
      return cmdDaemonStatus();
    case "logs":
      return cmdDaemonLogs(parsed.flags);
    default:
      usage();
  }
}

function usage(): never {
  console.error(
    [
      "Usage: mywayai <command> [options]",
      "",
      "Commands:",
      "  up [--seed-mock] [--port <n>] [--remote [--relay <url>]] [--name <n>] [-- <omp args>]",
      "                                                     Boot OmniRoute + omp (interactive)",
      "  down                                              Stop the managed OmniRoute process",
      "  status [--port <n>]                               Show reachability, pid, key state",
      "  logs [-f]                                         Print (or follow) the OmniRoute log",
      "  sync                                               Pull latest from both upstream subtrees",
      "",
      "  relay up [--port <n>] [--bind <host>] [--max-guests <n>]",
      "                                                     Boot the self-hosted collab relay",
      "  relay down                                        Stop the managed relay process",
      "  relay status [--port <n>]                          Show relay reachability + pid",
      "  relay logs [-f]                                    Print (or follow) the relay log",
      "",
      "  daemon up [--seed-mock] [--port <n>] [--remote [--relay <url>]] [--name <n>] [-- <omp args>]",
      "                                                     EXPERIMENTAL: headless omp --mode rpc",
      "                                                     (docs/adr/0002-remote-control.md 'Open question')",
      "  daemon down                                        Stop the managed daemon process",
      "  daemon status                                      Show daemon pid state",
      "  daemon logs [-f]                                   Print (or follow) the daemon log",
    ].join("\n"),
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "relay") {
    const [sub, ...relayRest] = rest;
    return dispatchRelay(sub, parseArgs(relayRest));
  }
  if (command === "daemon") {
    const [sub, ...daemonRest] = rest;
    return dispatchDaemon(sub, parseArgs(daemonRest));
  }

  const parsed = parseArgs(rest);
  switch (command) {
    case "up":
      return cmdUp(parsed);
    case "down":
      return cmdDown();
    case "status":
      return cmdStatus(parsed);
    case "logs":
      return cmdLogs(parsed);
    case "sync":
      return cmdSync();
    default:
      usage();
  }
}

await main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
