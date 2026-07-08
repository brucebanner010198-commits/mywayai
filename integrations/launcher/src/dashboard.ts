#!/usr/bin/env bun
// Local remote-control dashboard for `/collab` session links.
//
// The registry rendered here contains full write-capable `/collab` links. A
// link is therefore treated like an API key: never logged, never stored outside
// chmod-0600 state files, and never served before both the Tailscale bind choice
// and the OmniRoute-backed login gate have been checked.

import { openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  DEFAULT_OMNIROUTE_PORT,
  ensureStateDir,
  getDashboardLogFile,
  getDashboardPidFile,
  getDashboardSecretFile,
  getLogDir,
  getRepoRoot,
  omniRouteBaseUrl,
  resolveOmniRoutePort,
} from "@mywayai/omniroute-bridge";
import { isAllowedCollabUrl, isEntryAlive, readRegistry, type SessionEntry } from "@mywayai/session-registry";

export const DEFAULT_DASHBOARD_PORT = 7420;
const REQUIRE_LOGIN_TIMEOUT_MS = 8_000;
const LOGIN_TIMEOUT_MS = 8_000;
const TAILSCALE_TIMEOUT_MS = 3_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 5;
const DASH_COOKIE = "dash_session";

interface ParsedDashboardArgs {
  command: string | undefined;
  port?: number;
  host?: string;
  omniRoutePort?: number;
  allowNoLogin: boolean;
}

export interface DashboardOptions {
  port?: number;
  host?: string;
  omniRoutePort?: number;
  allowNoLogin?: boolean;
}

export interface DashboardServer {
  port?: number;
  stop(closeActiveConnections?: boolean): void;
}

interface RequireLoginStatus {
  requireLogin: boolean;
  hasPassword: boolean;
  setupComplete: boolean;
}



interface RateLimitEntry {
  count: number;
  windowStart: number;
}

interface DashboardPidInfo {
  pid: number;
  address?: string;
}

export interface DashboardStatus {
  running: boolean;
  pid?: number;
  address?: string;
  pidfile: string;
  logfile: string;
  reachable: boolean;
}

function parseDashboardArgs(argv: string[]): ParsedDashboardArgs {
  const [command, ...rest] = argv;
  const parsed: ParsedDashboardArgs = { command, allowNoLogin: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--allow-no-login") {
      parsed.allowNoLogin = true;
    } else if (arg === "--host" || arg === "--port" || arg === "--omniroute-port") {
      const next = rest[++i];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--host") parsed.host = next;
      else if (arg === "--port") parsed.port = Number(next);
      else parsed.omniRoutePort = Number(next);
    }
  }
  return parsed;
}

function assertPort(port: number, label: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} must be an integer from 1 to 65535.`);
  }
}

function validateHost(host: string): void {
  if (host === "0.0.0.0" || host === "::") {
    throw new Error("Dashboard refuses to bind to 0.0.0.0 or ::. Use a Tailscale IP or 127.0.0.1.");
  }
  // installDashboardUnit substitutes this raw into a launchd plist (XML) /
  // systemd unit file — reject anything outside a hostname/IPv4/bracketless-
  // IPv6 shape so it can't inject XML or corrupt the generated unit.
  if (!/^[A-Za-z0-9._:-]+$/.test(host)) {
    throw new Error("Dashboard host must contain only letters, digits, '.', '_', ':', or '-'.");
  }
}

function isIPv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d+$/.test(part)) return false;
    const n = Number(part);
    return n >= 0 && n <= 255 && String(n) === part;
  });
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function fromBase64url(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

function signPayload(payload: string, secret: Buffer): string {
  return base64url(createHmac("sha256", secret).update(payload).digest());
}

export function mintDashboardCookie(secret: Buffer, now = Date.now()): string {
  const payload = JSON.stringify({ exp: now + SESSION_TTL_MS });
  return `${base64url(payload)}.${signPayload(payload, secret)}`;
}

export function verifyDashboardCookie(cookieValue: string | undefined, secret: Buffer, now = Date.now()): boolean {
  if (!cookieValue) return false;
  const [payloadB64, signatureB64, extra] = cookieValue.split(".");
  if (!payloadB64 || !signatureB64 || extra !== undefined) return false;

  let payload: string;
  try {
    payload = fromBase64url(payloadB64).toString("utf8");
  } catch {
    return false;
  }

  const expected = fromBase64url(signPayload(payload, secret));
  let actual: Buffer;
  try {
    actual = fromBase64url(signatureB64);
  } catch {
    return false;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;

  try {
    const parsed: unknown = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object" || !("exp" in parsed) || typeof parsed.exp !== "number") return false;
    return parsed.exp > now;
  } catch {
    return false;
  }
}

function getCookie(request: Request, name: string): string | undefined {
  const raw = request.headers.get("cookie");
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [cookieName, ...valueParts] = part.trim().split("=");
    if (cookieName === name) return valueParts.join("=");
  }
  return undefined;
}

function shouldSecureCookie(request: Request): boolean {
  return process.env.MYWAYAI_DASHBOARD_COOKIE_SECURE === "true" || request.headers.get("x-forwarded-proto") === "https";
}

function sessionCookieHeader(value: string, request: Request): string {
  const parts = [`${DASH_COOKIE}=${value}`, "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (shouldSecureCookie(request)) parts.push("Secure");
  return parts.join("; ");
}

// Logout is stateless — it only clears the browser's copy of the cookie.
// The cookie itself is a self-contained signed token (mintDashboardCookie /
// verifyDashboardCookie): there is no server-side session store to revoke
// against, so a copy of the cookie value made before logout (or before an
// approved-device compromise) stays valid until its own 30-day expiry.
// Accepted given this ADR's threat model (docs/adr/0002-remote-control.md
// explicitly scopes device custody/compromise-after-approval to Tailscale
// device-approval revocation, not this layer) — call this out if that scope
// ever changes.
function clearCookieHeader(request: Request): string {
  const parts = [`${DASH_COOKIE}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (shouldSecureCookie(request)) parts.push("Secure");
  return parts.join("; ");
}

async function readOrCreateSecret(): Promise<Buffer> {
  await ensureStateDir();
  try {
    const existing = await readFile(getDashboardSecretFile());
    if (existing.length >= 32) return existing;
    throw new Error("Dashboard secret file is too short.");
  } catch (err) {
    const missing = !!err && typeof err === "object" && "code" in err && err.code === "ENOENT";
    if (!missing) throw err;
    const secret = randomBytes(32);
    await writeFile(getDashboardSecretFile(), secret, { mode: 0o600 });
    return secret;
  }
}

async function checkOmniRouteLogin(port: number, allowNoLogin: boolean): Promise<void> {
  const base = omniRouteBaseUrl(port);
  try {
    const res = await fetch(`${base}/api/settings/require-login`, {
      signal: AbortSignal.timeout(REQUIRE_LOGIN_TIMEOUT_MS),
      keepalive: false,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (!body || typeof body !== "object" || !("requireLogin" in body) || typeof body.requireLogin !== "boolean") {
      throw new Error("unexpected response shape");
    }
    const status: RequireLoginStatus = {
      requireLogin: body.requireLogin,
      hasPassword: "hasPassword" in body && typeof body.hasPassword === "boolean" ? body.hasPassword : false,
      setupComplete: "setupComplete" in body && typeof body.setupComplete === "boolean" ? body.setupComplete : false,
    };
    if (!status.requireLogin) {
      if (!allowNoLogin) {
        throw new Error("OmniRoute login is disabled — the application-layer gate this dashboard depends on would be a no-op. Re-enable OmniRoute login or pass --allow-no-login to accept Tailscale device approval as the only real gate.");
      }
      console.error("WARNING: OmniRoute login is disabled. Proceeding because --allow-no-login was passed; Tailscale device approval is now the only real gate before RCE-capable /collab links.");
    }
  } catch (err) {
    if (allowNoLogin) {
      console.error("WARNING: OmniRoute require-login could not be reached. Proceeding because --allow-no-login was passed; this is for local testing only unless Tailscale device approval is your intended only gate.");
      return;
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`OmniRoute is not reachable at ${base}. Run \`mywayai up\` first. (${detail})`);
  }
}

async function tailscaleIPv4(): Promise<string | undefined> {
  const proc = Bun.spawn({ cmd: ["tailscale", "ip", "-4"], stdio: ["ignore", "pipe", "ignore"] });
  const timeout = Bun.sleep(TAILSCALE_TIMEOUT_MS).then(() => "timeout" as const);
  const result = await Promise.race([proc.exited, timeout]);
  if (result === "timeout") {
    proc.kill();
    return undefined;
  }
  if (result !== 0) return undefined;
  const output = (await new Response(proc.stdout).text()).trim().split(/\s+/)[0];
  return output && isIPv4(output) ? output : undefined;
}

async function resolveBindHost(explicitHost: string | undefined): Promise<string> {
  if (explicitHost) {
    validateHost(explicitHost);
    return explicitHost;
  }
  const tailnetHost = await tailscaleIPv4();
  if (tailnetHost) return tailnetHost;
  console.error("WARNING: Tailscale IPv4 was not detected; dashboard will bind to 127.0.0.1 and be reachable only from this machine.");
  return "127.0.0.1";
}

function loginPage(error?: string): string {
  const errorBlock = error ? `<p class="error">${htmlEscape(error)}</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>mywayai dashboard login</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111827; color: #f9fafb; }
    main { width: min(92vw, 420px); padding: 2rem; border: 1px solid #374151; border-radius: 16px; background: #1f2937; }
    label, input, button { display: block; width: 100%; box-sizing: border-box; }
    input { margin: .5rem 0 1rem; padding: .8rem; border-radius: 10px; border: 1px solid #4b5563; background: #111827; color: #f9fafb; }
    button { padding: .8rem; border: 0; border-radius: 10px; background: #38bdf8; color: #082f49; font-weight: 700; cursor: pointer; }
    .error { padding: .75rem; border-radius: 10px; background: #7f1d1d; color: #fecaca; }
    .hint { color: #cbd5e1; font-size: .92rem; line-height: 1.45; }
  </style>
</head>
<body>
  <main>
    <h1>mywayai dashboard</h1>
    <p class="hint">Enter your OmniRoute dashboard password. The dashboard uses its own 30-day httpOnly session cookie after OmniRoute accepts the password.</p>
    ${errorBlock}
    <form method="post" action="/login">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
      <button type="submit">Log in</button>
    </form>
  </main>
</body>
</html>`;
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function dashboardPage(entries: SessionEntry[]): string {
  const rows = entries.map((entry) => {
    const href = isAllowedCollabUrl(entry.link) ? entry.link : "#";
    return `<li>
      <div>
        <strong>${htmlEscape(entry.name)}</strong>
        <span>${htmlEscape(relativeTime(entry.lastActiveAt))}</span>
      </div>
      <code>${htmlEscape(entry.cwd)}</code>
      <a href="${htmlEscape(href)}" rel="noreferrer">Join</a>
    </li>`;
  }).join("\n");
  const content = rows || `<p class="empty">No live sessions are registered. In a local omp session, run <code>/collab</code>, copy the link, then register it with the remote command.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>mywayai sessions</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #0f172a; color: #e5e7eb; }
    main { width: min(960px, 92vw); margin: 3rem auto; }
    header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
    h1 { margin: 0 0 .25rem; }
    form { margin: 0; }
    button, a { border-radius: 999px; padding: .55rem .9rem; font-weight: 700; }
    button { border: 1px solid #64748b; background: transparent; color: #e5e7eb; cursor: pointer; }
    ul { list-style: none; padding: 0; display: grid; gap: .75rem; }
    li { display: grid; grid-template-columns: 1fr auto; gap: .5rem 1rem; padding: 1rem; border: 1px solid #334155; border-radius: 14px; background: #1e293b; }
    li div { display: flex; gap: .75rem; align-items: baseline; }
    span, code, .empty { color: #cbd5e1; }
    code { grid-column: 1 / -1; white-space: pre-wrap; word-break: break-word; }
    a { grid-column: 2; grid-row: 1; background: #38bdf8; color: #082f49; text-decoration: none; }
    .empty { padding: 1rem; border: 1px dashed #475569; border-radius: 14px; }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Live sessions</h1>
        <p>RCE-capable /collab links are shown only after OmniRoute-backed login.</p>
      </div>
      <form method="post" action="/logout"><button type="submit">Log out</button></form>
    </header>
    <ul>${content}</ul>
  </main>
</body>
</html>`;
}

async function passwordFromRequest(request: Request): Promise<string | undefined> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body: unknown = await request.json().catch(() => undefined);
    if (body && typeof body === "object" && "password" in body && typeof body.password === "string") return body.password;
    return undefined;
  }
  const form = await request.formData().catch(() => undefined);
  const password = form?.get("password");
  return typeof password === "string" ? password : undefined;
}

export function checkRateLimit(map: Map<string, RateLimitEntry>, ip: string, now = Date.now()): boolean {
  const entry = map.get(ip);
  if (!entry || now - entry.windowStart >= LOGIN_WINDOW_MS) {
    map.set(ip, { count: 1, windowStart: now });
    return true;
  }
  entry.count += 1;
  return entry.count <= LOGIN_MAX_ATTEMPTS;
}

async function forwardLogin(password: string, port: number): Promise<boolean> {
  const res = await fetch(`${omniRouteBaseUrl(port)}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    keepalive: false,
  });
  if (!res.ok) return false;
  const body: unknown = await res.json().catch(() => undefined);
  return !!body && typeof body === "object" && "success" in body && body.success === true;
}

function redirect(location: string, headers?: Record<string, string>): Response {
  return new Response(null, { status: 303, headers: { location, ...headers } });
}

async function writePidFile(pid: number, host: string, port: number): Promise<void> {
  await ensureStateDir();
  await writeFile(getDashboardPidFile(), `${pid}\n${host}:${port}`, { mode: 0o600 });
}

async function readDashboardPid(): Promise<DashboardPidInfo | undefined> {
  try {
    const [pidLine, addressLine] = (await readFile(getDashboardPidFile(), "utf8")).trim().split("\n");
    const pid = Number(pidLine);
    if (!Number.isFinite(pid) || pid <= 0) return undefined;
    return { pid, address: addressLine };
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

async function isDashboardReachable(address: string | undefined): Promise<boolean> {
  if (!address) return false;
  try {
    const res = await fetch(`http://${address}/login`, { signal: AbortSignal.timeout(1_500), keepalive: false });
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function startDashboardServer(opts: DashboardOptions = {}): Promise<DashboardServer> {
  const port = opts.port ?? DEFAULT_DASHBOARD_PORT;
  const omniRoutePort = resolveOmniRoutePort(opts.omniRoutePort);
  assertPort(port, "Dashboard port");
  assertPort(omniRoutePort, "OmniRoute port");

  await checkOmniRouteLogin(omniRoutePort, opts.allowNoLogin === true);
  const host = await resolveBindHost(opts.host);
  const secret = await readOrCreateSecret();
  const attempts = new Map<string, RateLimitEntry>();

  const server = Bun.serve({
    hostname: host,
    port,
    async fetch(request, servingServer) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/login") {
        return new Response(loginPage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      if (request.method === "POST" && url.pathname === "/login") {
        const clientIp = servingServer.requestIP(request)?.address ?? "unknown";
        if (!checkRateLimit(attempts, clientIp)) {
          return new Response("Too many login attempts. Try again in a minute.", { status: 429, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
        }
        const password = await passwordFromRequest(request);
        if (!password) {
          return new Response(loginPage("Password is required."), { status: 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
        }
        const ok = await forwardLogin(password, omniRoutePort).catch(() => false);
        if (!ok) {
          return new Response(loginPage("OmniRoute rejected that password."), { status: 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
        }
        return redirect("/", { "set-cookie": sessionCookieHeader(mintDashboardCookie(secret), request) });
      }
      if (request.method === "POST" && url.pathname === "/logout") {
        return redirect("/login", { "set-cookie": clearCookieHeader(request) });
      }
      if (request.method === "GET" && url.pathname === "/") {
        if (!verifyDashboardCookie(getCookie(request, DASH_COOKIE), secret)) return redirect("/login");
        // This page renders full write-capable /collab links — never let a
        // shared/browsed device's cache retain it past logout.
        const liveEntries = (await readRegistry()).filter(isEntryAlive);
        return new Response(dashboardPage(liveEntries), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    },
    error() {
      return new Response("Internal server error", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
    },
  });

  await writePidFile(process.pid, host, port);
  console.log(`mywayai dashboard listening at http://${host}:${server.port}`);
  return server;
}

export async function startDashboardProcess(opts: DashboardOptions = {}): Promise<void> {
  const current = await readDashboardPid();
  if (current && isProcessAlive(current.pid)) {
    console.log(`mywayai dashboard is already running (pid ${current.pid}${current.address ? `, http://${current.address}` : ""}).`);
    return;
  }
  if (current) {
    console.error(`mywayai: dashboard pid ${current.pid} is not running (stale pidfile) — removing it.`);
    await rm(getDashboardPidFile(), { force: true });
  }

  await ensureStateDir();
  await mkdir(getLogDir(), { recursive: true, mode: 0o700 });
  const logFd = openSync(getDashboardLogFile(), "a");
  const cmd = [process.execPath, fileURLToPath(import.meta.url), "up"];
  if (opts.host) cmd.push("--host", opts.host);
  if (opts.port !== undefined) cmd.push("--port", String(opts.port));
  if (opts.omniRoutePort !== undefined) cmd.push("--omniroute-port", String(opts.omniRoutePort));
  if (opts.allowNoLogin) cmd.push("--allow-no-login");

  const proc = Bun.spawn({ cmd, cwd: getRepoRoot(), env: process.env as Record<string, string>, stdio: ["ignore", logFd, logFd] });
  proc.unref();
  console.log(`mywayai dashboard starting (pid ${proc.pid}).`);
  console.log(`pidfile: ${getDashboardPidFile()}`);
  console.log(`log:     ${getDashboardLogFile()}`);
}

export async function stopDashboardProcess(): Promise<void> {
  const info = await readDashboardPid();
  if (info === undefined) {
    console.error("mywayai: no dashboard pidfile found — nothing to stop.");
    return;
  }
  if (!isProcessAlive(info.pid)) {
    console.error(`mywayai: dashboard pid ${info.pid} is not running (stale pidfile) — removing it.`);
    await rm(getDashboardPidFile(), { force: true });
    return;
  }
  process.kill(info.pid, "SIGTERM");
  await rm(getDashboardPidFile(), { force: true });
}

export async function getDashboardStatus(): Promise<DashboardStatus> {
  const info = await readDashboardPid();
  const running = info ? isProcessAlive(info.pid) : false;
  return {
    running,
    pid: info?.pid,
    address: info?.address,
    pidfile: getDashboardPidFile(),
    logfile: getDashboardLogFile(),
    reachable: running ? await isDashboardReachable(info?.address) : false,
  };
}

function templatePath(name: string): string {
  return join(getRepoRoot(), "infra", "dashboard", name);
}

function quoteArg(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

async function resolveMywayaiBin(): Promise<string> {
  if (process.argv[1]) return resolve(process.argv[1]);
  const proc = Bun.spawn({ cmd: ["which", "mywayai"], stdio: ["ignore", "pipe", "ignore"] });
  if (await proc.exited === 0) {
    const found = (await new Response(proc.stdout).text()).trim();
    if (found) return found;
  }
  return join(getRepoRoot(), "integrations", "launcher", "src", "cli.ts");
}

export async function installDashboardUnit(opts: DashboardOptions = {}): Promise<void> {
  const args = ["dashboard", "up"];
  if (opts.host) args.push("--host", opts.host);
  if (opts.port !== undefined) args.push("--port", String(opts.port));
  if (opts.allowNoLogin) args.push("--allow-no-login");
  const binPath = await resolveMywayaiBin();
  // `binPath` may resolve to a raw .ts/.js source file (dev-mode fallback,
  // or even the "installed" case — bun's bin-symlink is just a link to
  // src/cli.ts, not a compiled binary). Relying on the OS to exec it
  // directly needs both the shebang AND the executable bit to survive
  // however the file got onto this machine (a plain git checkout doesn't
  // guarantee +x). Running it through `bun` explicitly removes that
  // dependency entirely.
  const runner = /\.(t|j)s$/.test(binPath) ? `bun ${quoteArg(binPath)}` : quoteArg(binPath);
  const substitutions = {
    binPath: runner,
    dashboardArgs: args.map(quoteArg).join(" "),
  };

  if (process.platform === "darwin") {
    const target = join(homedir(), "Library", "LaunchAgents", "com.mywayai.dashboard.plist");
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const template = await readFile(templatePath("launchd.plist.template"), "utf8");
    await Bun.write(
      target,
      template
        .replaceAll("{{BIN_PATH}}", substitutions.binPath)
        .replaceAll("{{DASHBOARD_ARGS}}", substitutions.dashboardArgs)
        .replaceAll("{{HOME}}", homedir()),
    );
    console.log(`Wrote ${target}`);
    console.log(`Run this yourself to enable it: launchctl load -w ${quoteArg(target)}`);
    return;
  }

  if (process.platform === "linux") {
    const target = join(homedir(), ".config", "systemd", "user", "mywayai-dashboard.service");
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const template = await readFile(templatePath("systemd.service.template"), "utf8");
    await Bun.write(target, template.replaceAll("{{BIN_PATH}}", substitutions.binPath).replaceAll("{{DASHBOARD_ARGS}}", substitutions.dashboardArgs));
    console.log(`Wrote ${target}`);
    console.log("Run this yourself to enable it: systemctl --user enable --now mywayai-dashboard");
    return;
  }

  throw new Error("dashboard install supports macOS launchd and Linux systemd only.");
}

function usage(): never {
  console.error("Usage: bun integrations/launcher/src/dashboard.ts up [--port <n>] [--host <addr>] [--allow-no-login]");
  process.exit(1);
}

async function main(): Promise<void> {
  const parsed = parseDashboardArgs(process.argv.slice(2));
  switch (parsed.command) {
    case "up":
      await startDashboardServer(parsed);
      return;
    default:
      usage();
  }
}

if (import.meta.main) {
  await main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
