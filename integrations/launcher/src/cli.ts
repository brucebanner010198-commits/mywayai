#!/usr/bin/env bun
// `mywayai` CLI — composes the omniroute-bridge functions into the day-to-day
// developer workflow: build/boot OmniRoute, provision it, wire omp's
// models.yml + extension, then exec the pinned omp binary.

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
  readKeyFile,
  resolveOmniRoutePort,
  seedMock,
  startOmniRoute,
  stopOmniRoute,
  writeModelsYaml,
} from "@mywayai/omniroute-bridge";
import {
  getDashboardStatus,
  installDashboardUnit,
  startDashboardProcess,
  stopDashboardProcess,
  type DashboardOptions,
} from "./dashboard.ts";

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
    else if (arg === "--host") flags.host = own[++i] ?? "";
    else if (arg === "--allow-no-login") flags["allow-no-login"] = true;
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

/** Shared OmniRoute boot sequence used by `up`. */
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

async function cmdUp({ flags, passthrough }: ParsedArgs): Promise<void> {
  const { port } = await bootOmniRouteAndExtension(flags);
  const env: Record<string, string> = { ...(process.env as Record<string, string>), OMNIROUTE_PORT: String(resolveOmniRoutePort(port)) };

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

function dashboardOptionsFromFlags(flags: ParsedArgs["flags"]): DashboardOptions {
  return {
    port: flags.port ? Number(flags.port) : undefined,
    host: typeof flags.host === "string" && flags.host ? flags.host : undefined,
    allowNoLogin: flags["allow-no-login"] === true,
  };
}

async function cmdDashboard(subcommand: string | undefined, args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  switch (subcommand) {
    case "up":
      return startDashboardProcess(dashboardOptionsFromFlags(parsed.flags));
    case "down":
      return stopDashboardProcess();
    case "status": {
      const status = await getDashboardStatus();
      console.log(`Dashboard: ${status.running ? "up" : "down"}${status.address ? ` (${status.address})` : ""}`);
      console.log(`reachable: ${status.reachable ? "yes" : "no"}`);
      console.log(`pidfile:   ${status.pidfile}`);
      console.log(`log:       ${status.logfile}`);
      if (status.pid) console.log(`pid:       ${status.pid}`);
      return;
    }
    case "install":
      return installDashboardUnit(dashboardOptionsFromFlags(parsed.flags));
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
      "  up [--seed-mock] [--port <n>] [-- <omp args>]          Boot OmniRoute + omp (interactive)",
      "  down                                                   Stop the managed OmniRoute process",
      "  status [--port <n>]                                    Show reachability, pid, key state",
      "  logs [-f]                                              Print (or follow) the OmniRoute log",
      "  dashboard up [--port <n>] [--host <addr>] [--allow-no-login]",
      "                                                         Start the Tailscale/localhost session dashboard",
      "  dashboard down                                         Stop the managed dashboard process",
      "  dashboard status                                       Show dashboard reachability, pid, and paths",
      "  dashboard install [--port <n>] [--host <addr>] [--allow-no-login]",
      "                                                         Write a launchd/systemd unit without enabling it",
      "  sync                                                   Pull latest from both upstream subtrees",
    ].join("\n"),
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
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
    case "dashboard": {
      const [subcommand, ...dashboardArgs] = rest;
      return cmdDashboard(subcommand, dashboardArgs);
    }
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
