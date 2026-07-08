// omp extension exposing OmniRoute's admin surface (combos, quota, usage,
// fallback, health, sessions, role mapping, key rotation) via the `/omni`
// command, plus `/remote` registration for OmniRoute's remote dashboard.
//
// Type-only import from @oh-my-pi/pi-coding-agent (no runtime dependency on
// it — the built dist/omniroute.js is a standalone file). HTTP via the
// global `fetch`. Small duplication vs. integrations/omniroute-bridge is
// intentional: this file must stay dependency-free of the bridge workspace
// package (see writeRoleMapping/rotateKeyHere below) — see docs/architecture.md.

import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { SessionEntry } from "@mywayai/session-registry";
import { isEntryAlive, readRegistry, removeRegistryEntry, upsertRegistryEntry } from "@mywayai/session-registry";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import yaml from "js-yaml";

// `registerTool`'s `TParams extends TSchema` (TSchema = the SDK's internal
// ArkSchema-based shim) infers `Static<TParams>` from zod v4 schemas via a
// structural check that hits TS2589 ("type instantiation excessively deep")
// for any non-empty zod object once `execute`'s `params` argument is
// actually consumed — reproduced in isolation against the published
// @oh-my-pi/pi-coding-agent@16.3.11 types with a bare `tsc --noEmit` (`bun
// build`, which never type-checks, is unaffected — this is a typecheck-only
// issue). Route the one affected registration through this alias, which
// bypasses generic inference at the call site while keeping `execute`'s own
// parameter types explicit and checked.
type RegisterToolArg = Parameters<ExtensionAPI["registerTool"]>[0];

const DEFAULT_PORT = 20128;
const VALID_ROLE_IDS = [
  "default",
  "smol",
  "slow",
  "vision",
  "plan",
  "designer",
  "commit",
  "tiny",
  "task",
  "advisor",
] as const;

function stateDir(): string {
  return process.env.MYWAYAI_STATE_DIR ?? join(homedir(), ".mywayai");
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
}

function keyFile(): string {
  return join(stateDir(), "omniroute.key");
}

function keyIdFile(): string {
  return join(stateDir(), "omniroute.key.id");
}

function agentConfigYamlPath(): string {
  return join(agentDir(), "config.yml");
}

function baseUrl(): string {
  const port = process.env.OMNIROUTE_PORT ? Number(process.env.OMNIROUTE_PORT) : DEFAULT_PORT;
  return `http://localhost:${port}`;
}

class OmniRouteUnreachableError extends Error {}

const REMOTE_SESSION_ID = String(process.pid);
const REMOTE_HEARTBEAT_MS = 30_000;
let remoteHeartbeat: NodeJS.Timeout | undefined;

/** Tiny typed fetch helper. Reads the key lazily per call so it survives `key rotate`. */
async function omni<T>(path: string, init: RequestInit = {}): Promise<T> {
  let key: string | undefined;
  try {
    key = (await readFile(keyFile(), "utf8")).trim() || undefined;
  } catch {
    key = undefined;
  }

  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(10_000),
      // Bun's fetch reuses keep-alive connections across calls from the same
      // process; a long-lived omp session making many /omni calls hangs on a
      // reused connection against this server. Force a fresh connection.
      keepalive: false,
    });
  } catch {
    throw new OmniRouteUnreachableError("OmniRoute is not running — start it with `mywayai up`.");
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OmniRoute request failed: ${init.method ?? "GET"} ${path} -> ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

function renderJson(data: unknown, limit?: number): string {
  if (Array.isArray(data)) {
    const items = limit ? data.slice(0, limit) : data;
    if (items.length === 0) return "(empty)";
    return items.map((item, i) => `${i + 1}. ${JSON.stringify(item)}`).join("\n");
  }
  if (data && typeof data === "object") {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) return "(empty)";
    return entries.map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join("\n");
  }
  return String(data);
}

// ---- duplicated ~30-line role-mapping helper (see integrations/omniroute-bridge/src/roles.ts) ----
// Kept as a standalone copy rather than a workspace import so the built
// extension bundle has no dependency on the bridge package.
async function writeRoleMappingHere(role: string, comboName: string): Promise<void> {
  if (!(VALID_ROLE_IDS as readonly string[]).includes(role)) {
    throw new Error(`Unknown omp model role "${role}". Valid roles: ${VALID_ROLE_IDS.join(", ")}`);
  }
  const { combos } = await omni<{ combos: Array<{ name: string }> }>("/api/combos");
  const comboNames = combos.map((c) => c.name);
  if (!comboNames.includes(comboName)) {
    throw new Error(`Combo "${comboName}" does not exist. Existing combos: ${comboNames.join(", ") || "(none)"}`);
  }

  const path = agentConfigYamlPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let doc: Record<string, unknown> = {};
  try {
    const parsed = yaml.load(await readFile(path, "utf8"));
    if (parsed && typeof parsed === "object") doc = parsed as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const modelRoles = (doc.modelRoles && typeof doc.modelRoles === "object" ? doc.modelRoles : {}) as Record<
    string,
    string
  >;
  modelRoles[role] = `omniroute/${comboName}`;
  doc.modelRoles = modelRoles;
  await Bun.write(path, yaml.dump(doc, { lineWidth: -1 }));
}

// ---- duplicated key-rotation helper (see integrations/omniroute-bridge/src/keys.ts) ----
async function rotateKeyHere(): Promise<string> {
  const id = (await readFile(keyIdFile(), "utf8").catch(() => "")).trim();
  const key = (await readFile(keyFile(), "utf8").catch(() => "")).trim();
  if (!id || !key) throw new Error("No existing OmniRoute key/id on disk — run `mywayai up` first.");

  const res = await fetch(`${baseUrl()}/api/keys/${id}/regenerate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
    keepalive: false,
  });
  if (!res.ok) throw new Error(`Failed to rotate OmniRoute key: ${res.status}`);
  const data = (await res.json()) as { key?: string; id?: string };
  if (!data.key) throw new Error("OmniRoute regenerate response did not include a plaintext key.");

  await mkdir(stateDir(), { recursive: true, mode: 0o700 });
  await chmod(stateDir(), 0o700);
  await writeFile(keyFile(), data.key, { mode: 0o600 });
  if (data.id) {
    await writeFile(keyIdFile(), data.id, { mode: 0o600 });
  }
  return data.key;
}

async function readModelRoles(): Promise<Record<string, string>> {
  try {
    const parsed = yaml.load(await readFile(agentConfigYamlPath(), "utf8"));
    const doc = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    return (doc.modelRoles && typeof doc.modelRoles === "object" ? doc.modelRoles : {}) as Record<string, string>;
  } catch {
    return {};
  }
}

async function readApprovalMode(): Promise<string | undefined> {
  const path = agentConfigYamlPath();
  try {
    const parsed = yaml.load(await readFile(path, "utf8"));
    const doc = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    const tools = doc.tools && typeof doc.tools === "object" ? (doc.tools as Record<string, unknown>) : {};
    const approvalMode = tools.approvalMode;
    if (typeof approvalMode !== "string") return undefined;
    return approvalMode;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

function parseRemoteRegisterArgs(rest: string[]): { link?: string; name?: string; force: boolean } {
  const force = rest.includes("--force");
  const positional = rest.filter((part) => part !== "--force");
  const [link, ...nameParts] = positional;
  const name = nameParts.join(" ").trim();
  return { link, name: name || undefined, force };
}

function sessionNameForRemote(ctx: ExtensionCommandContext, pi: ExtensionAPI, explicitName?: string): string {
  const nameFromContext = (ctx as ExtensionCommandContext & { getSessionName?: () => string | undefined }).getSessionName?.();
  const fallbackName = basename(ctx.cwd) || ctx.cwd;
  return explicitName ?? nameFromContext ?? pi.getSessionName() ?? fallbackName;
}

function collabSecretSegment(link: string): string | undefined {
  let candidate = link.trim();
  try {
    candidate = decodeURIComponent(candidate);
  } catch {
    // Some terminals paste already-mangled fragments; the check is advisory,
    // so keep inspecting the original text instead of blocking registration.
  }
  const hashIndex = candidate.indexOf("#");
  if (hashIndex >= 0) {
    const beforeHash = candidate.slice(0, hashIndex);
    const fragment = candidate.slice(hashIndex + 1);
    const browserWrapper = /^https?:\/\//.test(beforeHash) && !beforeHash.includes("/r/");
    if (browserWrapper && (fragment.includes(".") || fragment.includes("#") || fragment.includes("/r/"))) {
      candidate = fragment;
    }
  }
  const separator = Math.max(candidate.lastIndexOf("."), candidate.lastIndexOf("#"));
  if (separator < 0 || separator === candidate.length - 1) return undefined;
  return candidate.slice(separator + 1).split(/[/?&]/, 1)[0];
}

function decodedBase64UrlBytes(value: string): number | undefined {
  const unpadded = value.replace(/=+$/, "");
  if (!/^[A-Za-z0-9_-]+$/.test(unpadded) || unpadded.length % 4 === 1) return undefined;
  const bits = unpadded.length * 6;
  return Math.floor(bits / 8);
}

function collabLinkWarning(link: string): string | undefined {
  const secret = collabSecretSegment(link);
  if (!secret) {
    return "That does not look like a full /collab link: no trailing .<key> or #<key> secret was found.";
  }
  const bytes = decodedBase64UrlBytes(secret);
  if (bytes === 32) {
    return "That link looks like a view-only /collab view link (32-byte secret), not a full-control /collab link.";
  }
  if (bytes !== 48) {
    return "That link's secret length is not the expected 48 raw bytes for a full /collab link; continuing because this is only a sanity check.";
  }
  return undefined;
}

function maskCollabLink(link: string): string {
  if (link.length <= 8) return "…";
  return `${link.slice(0, 8)}…`;
}

function startRemoteHeartbeat(entry: SessionEntry): void {
  clearInterval(remoteHeartbeat);
  remoteHeartbeat = setInterval(() => {
    const next = { ...entry, lastActiveAt: new Date().toISOString() };
    void upsertRegistryEntry(next).catch(() => undefined);
  }, REMOTE_HEARTBEAT_MS);
  remoteHeartbeat.unref?.();
}

async function stopRemoteHeartbeatAndRemove(): Promise<void> {
  if (remoteHeartbeat) {
    clearInterval(remoteHeartbeat);
    remoteHeartbeat = undefined;
  }
  await removeRegistryEntry(REMOTE_SESSION_ID);
}

async function handleRemoteRegister(pi: ExtensionAPI, ctx: ExtensionCommandContext, rest: string[]): Promise<void> {
  const { link, name, force } = parseRemoteRegisterArgs(rest);
  if (!link) {
    ctx.ui.notify("Usage: /remote register <link> [name] [--force]", "error");
    return;
  }

  const approvalMode = await readApprovalMode();
  const dangerousApprovalMode = approvalMode === undefined || approvalMode === "yolo";
  const rceWarning =
    "A full /collab link is an RCE-capable credential, and every tool call auto-approves under the current/default tools.approvalMode.";
  if (dangerousApprovalMode) {
    ctx.ui.notify(
      force
        ? `${rceWarning} Proceeding because --force was passed.`
        : `Refusing to register this link. ${rceWarning} Set tools.approvalMode away from yolo, or pass --force if you accept the risk.`,
      force ? "warning" : "error",
    );
    if (!force) return;
  }

  const shapeWarning = collabLinkWarning(link);
  if (shapeWarning) ctx.ui.notify(shapeWarning, "warning");

  const entry: SessionEntry = {
    id: REMOTE_SESSION_ID,
    name: sessionNameForRemote(ctx, pi, name),
    cwd: ctx.cwd,
    link,
    lastActiveAt: new Date().toISOString(),
    pid: process.pid,
  };
  await upsertRegistryEntry(entry);
  startRemoteHeartbeat(entry);
  ctx.ui.notify(
    `Registered remote session "${entry.name}" at ${entry.cwd}. Use /remote unregister to remove it; if this process exits, the heartbeat stops and the registry prunes it.`,
    "info",
  );
}

async function handleRemoteStatus(ctx: ExtensionCommandContext): Promise<void> {
  const entry = (await readRegistry()).find((item) => item.id === REMOTE_SESSION_ID);
  if (!entry) {
    ctx.ui.notify("Remote session is not registered.", "info");
    return;
  }
  ctx.ui.notify(
    [
      `Remote session "${entry.name}"`,
      `cwd: ${entry.cwd}`,
      `pid: ${entry.pid} (${isEntryAlive(entry) ? "alive" : "stale"})`,
      `lastActiveAt: ${entry.lastActiveAt}`,
      `link: ${maskCollabLink(entry.link)}`,
    ].join("\n"),
    "info",
  );
}

async function handleRemoteUnregister(ctx: ExtensionCommandContext): Promise<void> {
  await stopRemoteHeartbeatAndRemove();
  ctx.ui.notify("Remote session unregistered.", "info");
}

interface Combo {
  name: string;
  strategy?: string;
  models?: unknown[];
}

async function notifyUnreachableOr(ctx: ExtensionCommandContext, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
  }
}

async function handleCombos(ctx: ExtensionCommandContext, rest: string[]): Promise<void> {
  if (rest[0] === "create") {
    const [name, ...models] = rest.slice(1);
    if (!name || models.length === 0) {
      ctx.ui.notify("Usage: /omni combos create <name> <model...>", "error");
      return;
    }
    await omni("/api/combos", {
      method: "POST",
      body: JSON.stringify({ name, models, strategy: "priority" }),
    });
    ctx.ui.notify(`Created combo "${name}" with ${models.length} model(s).`, "info");
    return;
  }
  const { combos } = await omni<{ combos: Combo[] }>("/api/combos");
  const roles = await readModelRoles();
  const lines = combos.map(
    (c) => `${c.name.padEnd(30)} ${(c.strategy ?? "priority").padEnd(12)} ${c.models?.length ?? 0} target(s)`,
  );
  const roleLines = Object.entries(roles)
    .filter(([, v]) => v.startsWith("omniroute/"))
    .map(([role, v]) => `  ${role} -> ${v.slice("omniroute/".length)}`);
  ctx.ui.notify(
    [
      lines.length ? lines.join("\n") : "(no combos yet)",
      roleLines.length ? `\nRoles -> omniroute/*:\n${roleLines.join("\n")}` : "",
    ].join(""),
    "info",
  );
}

async function handleQuota(ctx: ExtensionCommandContext): Promise<void> {
  ctx.ui.notify(renderJson(await omni("/api/quota/pools")), "info");
}

async function handleUsage(ctx: ExtensionCommandContext, rest: string[]): Promise<void> {
  if (rest[0] === "log") {
    ctx.ui.notify(renderJson(await omni("/api/usage/call-logs"), 10), "info");
    return;
  }
  ctx.ui.notify(renderJson(await omni("/api/usage/analytics")), "info");
}

async function handleFallback(ctx: ExtensionCommandContext): Promise<void> {
  ctx.ui.notify(renderJson(await omni("/api/fallback/chains")), "info");
}

async function handleHealth(ctx: ExtensionCommandContext): Promise<void> {
  ctx.ui.notify(renderJson(await omni("/api/providers/health-matrix")), "info");
}

async function handleSessions(ctx: ExtensionCommandContext): Promise<void> {
  const data = await omni<{ count: number; byApiKey: unknown }>("/api/sessions");
  ctx.ui.notify(`count: ${data.count}\nbyApiKey: ${JSON.stringify(data.byApiKey)}`, "info");
}

async function handleRole(ctx: ExtensionCommandContext, rest: string[]): Promise<void> {
  const [role, combo] = rest;
  if (!role || !combo) {
    ctx.ui.notify("Usage: /omni role <role> <combo>", "error");
    return;
  }
  await writeRoleMappingHere(role, combo);
  await ctx.reload();
  ctx.ui.notify(`Mapped role "${role}" -> omniroute/${combo} (reloaded).`, "info");
}

async function handleKey(ctx: ExtensionCommandContext, rest: string[]): Promise<void> {
  if (rest[0] === "rotate") {
    await rotateKeyHere();
    ctx.ui.notify("OmniRoute API key rotated.", "info");
    return;
  }
  ctx.ui.notify("Usage: /omni key rotate", "error");
}

const OMNI_USAGE = [
  "Usage: /omni <combos|combos create|quota|usage|usage log|fallback|health|sessions|role|key rotate>",
  "  combos                        List combos + role mappings",
  "  combos create <name> <model>  Create a combo",
  "  quota                         Show quota pools",
  "  usage                         Show usage analytics summary",
  "  usage log                     Show the last 10 call log entries",
  "  fallback                      Show fallback chains",
  "  health                        Show provider health matrix",
  "  sessions                      Show live SSE session counts",
  "  role <role> <combo>           Map an omp role to a combo (live)",
  "  key rotate                    Regenerate the OmniRoute API key",
].join("\n");

const REMOTE_USAGE = [
  "Usage: /remote <register|status|unregister>",
  "  register <link> [name] [--force]  Register this process's full /collab link for the remote dashboard",
  "  status                            Show this process's registry entry with the link masked",
  "  unregister                        Remove this process from the remote dashboard registry",
].join("\n");

export default function omniRouteExtension(pi: ExtensionAPI): void {
  const { z } = pi.zod;

  pi.on("session_start", async (_event, ctx) => {
    let reachable = false;
    try {
      reachable = (await fetch(`${baseUrl()}/api/health/ping`, { signal: AbortSignal.timeout(2000), keepalive: false })).status < 500;
    } catch {
      reachable = false;
    }
    const roles = await readModelRoles();
    const activeDefault = roles.default ?? "(unmapped)";
    ctx.ui.notify(
      reachable
        ? `OmniRoute reachable at ${baseUrl()} — default role -> ${activeDefault}`
        : `OmniRoute is not running — start it with \`mywayai up\`.`,
      reachable ? "info" : "warning",
    );
  });

  pi.on("session_shutdown", async () => {
    clearInterval(remoteHeartbeat);
    remoteHeartbeat = undefined;
    try {
      await removeRegistryEntry(REMOTE_SESSION_ID);
    } catch {
      // Best-effort cleanup only: shutdown is already in progress and stale
      // entries self-prune once their heartbeat stops.
    }
  });

  pi.registerCommand("omni", {
    description: "OmniRoute: combos, quota, usage, fallback, health, sessions, roles, keys",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const [sub, ...rest] = parts;

      await notifyUnreachableOr(ctx, async () => {
        switch (sub) {
          case "combos":
            return handleCombos(ctx, rest);
          case "quota":
            return handleQuota(ctx);
          case "usage":
            return handleUsage(ctx, rest);
          case "fallback":
            return handleFallback(ctx);
          case "health":
            return handleHealth(ctx);
          case "sessions":
            return handleSessions(ctx);
          case "role":
            return handleRole(ctx, rest);
          case "key":
            return handleKey(ctx, rest);
          default:
            ctx.ui.notify(OMNI_USAGE, "info");
        }
      });
    },
  });

  pi.registerCommand("remote", {
    description: "Remote dashboard: register, inspect, or unregister this /collab session",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const [sub, ...rest] = parts;

      try {
        switch (sub) {
          case "register":
            return handleRemoteRegister(pi, ctx, rest);
          case "status":
            return handleRemoteStatus(ctx);
          case "unregister":
            return handleRemoteUnregister(ctx);
          default:
            ctx.ui.notify(REMOTE_USAGE, "info");
        }
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
  });

  pi.registerTool({
    name: "omni_usage",
    label: "OmniRoute Usage",
    description: "Fetch OmniRoute usage analytics (requests, tokens, cost, success rate).",
    parameters: z.object({}),
    approval: "read",
    async execute() {
      const data = await omni("/api/usage/analytics");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  });

  pi.registerTool({
    name: "omni_switch_combo",
    label: "Switch OmniRoute Combo",
    description:
      "Map an omp model role to a different OmniRoute combo (e.g. under quota pressure). " +
      "Takes effect for new sessions; use `/omni role` for an immediate live switch.",
    parameters: z.object({
      role: z.string().describe(`Role id: one of ${VALID_ROLE_IDS.join(", ")}`),
      combo: z.string().min(1),
    }),
    approval: "write",
    formatApprovalDetails: (args: unknown) => {
      const { role, combo } = args as { role: string; combo: string };
      return `Role: ${role} -> omniroute/${combo} (writes ~/.omp/agent/config.yml)`;
    },
    async execute(_toolCallId: string, params: { role: string; combo: string }) {
      await writeRoleMappingHere(params.role, params.combo);
      return {
        content: [
          {
            type: "text",
            text: `Mapped role "${params.role}" -> omniroute/${params.combo}. Takes effect for new sessions; use /omni role for a live switch.`,
          },
        ],
      };
    },
  } as unknown as RegisterToolArg);
}
