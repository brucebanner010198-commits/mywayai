import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { checkRateLimit, mintDashboardCookie, startDashboardServer, verifyDashboardCookie, type DashboardServer } from "./dashboard.ts";

const servers: DashboardServer[] = [];
const stateDirs: string[] = [];

async function freePort(): Promise<number> {
  const server = createServer();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
  await promise;
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const closed = Promise.withResolvers<void>();
  server.close((err) => {
    if (err) closed.reject(err);
    else closed.resolve();
  });
  await closed.promise;
  return port;
}

async function useTempState(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mywayai-dashboard-test-"));
  process.env.MYWAYAI_STATE_DIR = dir;
  stateDirs.push(dir);
}

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of stateDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  delete process.env.MYWAYAI_STATE_DIR;
});

test("dashboard cookie signs expiring payloads and rejects tampering", () => {
  const secret = Buffer.alloc(32, 7);
  const cookie = mintDashboardCookie(secret, 1_000);
  expect(verifyDashboardCookie(cookie, secret, 2_000)).toBe(true);
  expect(verifyDashboardCookie(`${cookie}x`, secret, 2_000)).toBe(false);
  expect(verifyDashboardCookie(cookie, Buffer.alloc(32, 8), 2_000)).toBe(false);
  expect(verifyDashboardCookie(cookie, secret, 31 * 24 * 60 * 60 * 1000)).toBe(false);
});

test("rate limiter allows five attempts per fixed window", () => {
  const attempts = new Map<string, { count: number; windowStart: number }>();
  for (let i = 0; i < 5; i++) expect(checkRateLimit(attempts, "100.64.0.10", 10_000)).toBe(true);
  expect(checkRateLimit(attempts, "100.64.0.10", 10_000)).toBe(false);
  expect(checkRateLimit(attempts, "100.64.0.10", 71_000)).toBe(true);
});

test("allow-no-login boots without a live OmniRoute for local login-page smoke testing", async () => {
  await useTempState();
  const port = await freePort();
  const dashboard = await startDashboardServer({ host: "127.0.0.1", port, omniRoutePort: 9, allowNoLogin: true });
  servers.push(dashboard);

  const res = await fetch(`http://127.0.0.1:${port}/login`);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("mywayai dashboard");
});

test("login proxies to OmniRoute and then protects the session list", async () => {
  await useTempState();
  const mockOmniRoute = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/settings/require-login") {
        return Response.json({ requireLogin: true, hasPassword: true, setupComplete: true });
      }
      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        const body: unknown = await request.json();
        if (body && typeof body === "object" && "password" in body && body.password === "correct") {
          return Response.json({ success: true });
        }
        return Response.json({ error: "bad password" }, { status: 401 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(mockOmniRoute);

  const port = await freePort();
  const dashboard = await startDashboardServer({ host: "127.0.0.1", port, omniRoutePort: mockOmniRoute.port });
  servers.push(dashboard);

  const unauthenticated = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
  expect(unauthenticated.status).toBe(303);
  expect(unauthenticated.headers.get("location")).toBe("/login");

  const login = await fetch(`http://127.0.0.1:${port}/login`, {
    method: "POST",
    body: new URLSearchParams({ password: "correct" }),
    redirect: "manual",
  });
  expect(login.status).toBe(303);
  const cookie = login.headers.get("set-cookie");
  expect(cookie).toContain("dash_session=");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Lax");

  const list = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie: cookie ?? "" } });
  expect(list.status).toBe(200);
  expect(await list.text()).toContain("No live sessions are registered");
});
