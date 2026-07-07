// CONFIRMED BROKEN as of the pinned @oh-my-pi/pi-coding-agent@16.3.11 (docs/adr/0002-remote-control.md
// "Open question", Option 2): runs omp headlessly via `--mode rpc` instead
// of the interactive TUI, so the agent (and, if --remote is set, an attempt
// at /collab) keeps running with nobody locally attached — closer to "walk
// away, check from your phone later" than `mywayai up --remote`'s
// interactive-session-sharing default.
//
// This was empirically tested against a real omp --mode rpc process (not
// inferred from docs): sending `{"type":"prompt","message":"/collab"}` does
// NOT register as a slash command. The RPC `available_commands_update` frame
// never lists "collab" among builtins, and the sent text is echoed back as
// an ordinary `role:"user"` chat message followed by a real `agent_start` /
// model turn — the exact opposite of a recognized local-only command, which
// instead responds with `data.agentInvoked:false` and a `command_output`
// frame and no model call at all (verified by contrast against `/jobs`,
// which does behave that way under RPC mode). Sending `/collab` here
// therefore currently just burns one wasted, possibly-billed model turn and
// starts nothing.
//
// This driver still attempts it (a future omp release may add RPC support
// for /collab, and the detection below will then correctly report success),
// but reports the CONFIRMED failure plainly rather than hedging — re-run
// docs/remote-control-test-checklist.md's daemon item after any
// integrations/launcher package.json / omp-omniroute-extension version bump
// (docs/upstream-sync.md "Version pins to watch") to see if this changed.

import { openSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { getStateDir } from "@mywayai/omniroute-bridge";

// Blind grace period before the first stdin write, mirroring the same
// accepted pattern @mywayai/omniroute-bridge/src/server.ts uses
// (INITIAL_GRACE_MS) for its own child-process handshake — this repo does
// not pipe+parse the child's stdout here (see module comment above), so
// there is no `{"type":"ready"}` frame to synchronize on directly.
const READY_GRACE_MS = 2_000;
const COLLAB_PROBE_DELAY_MS = 5_000;
// Marks a recognized local-only slash command's `prompt` response
// (vendor/oh-my-pi/docs/rpc.md: `data.agentInvoked: false`) — present iff
// the response line for our known id also carries this substring. Absence
// within the window, or a following `agent_start`, means the text was sent
// to the model instead (the confirmed /collab failure mode described above).
const AGENT_NOT_INVOKED_MARKER = '"agentInvoked":false';

export function getDaemonPidFile(): string {
  return join(getStateDir(), "omp-daemon.pid");
}

export function getDaemonLogFile(): string {
  return join(getStateDir(), "logs", "omp-daemon.log");
}

async function readDaemonPid(): Promise<number | undefined> {
  try {
    const raw = (await readFile(getDaemonPidFile(), "utf8")).trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function isDaemonUp(): Promise<boolean> {
  const pid = await readDaemonPid();
  return pid !== undefined && isProcessAlive(pid);
}

export interface StartDaemonOptions {
  ompBin: string;
  passthrough: string[];
  env: Record<string, string>;
  /** Attempt the experimental /collab autostart over RPC stdin (see module comment). */
  remote: boolean;
}

export async function startDaemon(opts: StartDaemonOptions): Promise<void> {
  if (await isDaemonUp()) {
    console.log("mywayai: daemon already running (`mywayai daemon status` for details).");
    return;
  }

  await mkdir(join(getStateDir(), "logs"), { recursive: true, mode: 0o700 });
  const logFd = openSync(getDaemonLogFile(), "a");

  const proc = Bun.spawn({
    cmd: [opts.ompBin, "--mode", "rpc", ...opts.passthrough],
    env: opts.env,
    stdin: "pipe",
    stdout: logFd,
    stderr: logFd,
  });
  proc.unref();
  await Bun.write(getDaemonPidFile(), String(proc.pid));

  await Bun.sleep(READY_GRACE_MS);

  if (opts.remote) {
    try {
      const line = `${JSON.stringify({ type: "prompt", id: "mywayai-remote-autostart", message: "/collab" })}\n`;
      proc.stdin.write(line);
      // Deliberately never close stdin: RPC mode exits when stdin closes
      // (vendor/oh-my-pi/docs/rpc.md, "When stdin closes ... the process
      // exits with code 0"), and this daemon is meant to keep running.
    } catch (err) {
      console.error(`mywayai: failed to write the /collab autostart prompt: ${err instanceof Error ? err.message : err}`);
    }

    await Bun.sleep(COLLAB_PROBE_DELAY_MS);
    const tail = await readFile(getDaemonLogFile(), "utf8").catch(() => "");
    const recent = tail.split("\n").slice(-80).join("\n");
    const recognizedAsLocalCommand =
      recent.includes('"id":"mywayai-remote-autostart"') && recent.includes(AGENT_NOT_INVOKED_MARKER);
    if (recognizedAsLocalCommand) {
      console.log("mywayai: /collab was recognized as a local RPC command — run `mywayai daemon logs` for the join link.");
    } else {
      console.error(
        "mywayai: /collab did NOT start — this omp build does not recognize it as an RPC command; the prompt " +
          "was sent to the model as literal text instead (confirmed behavior, not a guess — see the module " +
          "comment in integrations/launcher/src/daemon.ts and docs/adr/0002-remote-control.md's 'Open question'). " +
          "Use `mywayai up --remote` (interactive) for remote control today. The daemon itself is still running " +
          "normally — only the /collab autostart attempt failed. Inspect the log: `mywayai daemon logs -f`.",
      );
    }
  }

  console.log(`mywayai: daemon started (pid ${proc.pid}). Log: ${getDaemonLogFile()}`);
}

export async function stopDaemon(): Promise<void> {
  const pid = await readDaemonPid();
  if (pid === undefined) {
    console.error("mywayai: no daemon pidfile found — nothing to stop.");
    return;
  }
  if (!isProcessAlive(pid)) {
    console.error(`mywayai: daemon pid ${pid} is not running (stale pidfile) — removing it.`);
    await rm(getDaemonPidFile(), { force: true });
    return;
  }
  process.kill(pid, "SIGTERM");
  await rm(getDaemonPidFile(), { force: true });
}
