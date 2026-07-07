// OmniRoute API key provisioning.
//
// Correction vs. the original plan (verified live, 2026-07-07): OmniRoute
// ships `INITIAL_PASSWORD=CHANGEME` in `.env.example`, and `npm ci`'s
// postinstall copies it into `vendor/omniroute/.env`. That makes
// `isAuthRequired()` return `true` from the very first boot — an
// unauthenticated `POST /api/keys` on a genuinely fresh install returns 401,
// not 201. Bootstrap therefore logs in with the password from
// `vendor/omniroute/.env` (falling back to the well-known "CHANGEME"
// default) to obtain a dashboard session cookie, then uses that cookie for
// the one-time key mint. An unauthenticated attempt is still tried first, in
// case a user has explicitly set `requireLogin: false`.

import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { bootstrapFetch } from "./http.ts";
import { getKeyFile, getKeyIdFile, getOmniRouteVendorDir, getStateDir, omniRouteBaseUrl } from "./paths.ts";

interface CreatedKey {
  key: string;
  id: string;
}

async function persistKey(key: string, id?: string): Promise<void> {
  await mkdir(getStateDir(), { recursive: true, mode: 0o700 });
  await Bun.write(getKeyFile(), key);
  await chmod(getKeyFile(), 0o600);
  if (id) {
    await Bun.write(getKeyIdFile(), id);
    await chmod(getKeyIdFile(), 0o600);
  }
}

export async function readKeyFile(): Promise<string | undefined> {
  try {
    const raw = (await readFile(getKeyFile(), "utf8")).trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

export async function readKeyIdFile(): Promise<string | undefined> {
  try {
    const raw = (await readFile(getKeyIdFile(), "utf8")).trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

export async function requireKey(): Promise<string> {
  const key = await readKeyFile();
  if (!key) throw new Error("No OmniRoute API key on disk — run provisionKey() first (e.g. `mywayai up`).");
  return key;
}

async function readInitialPasswordFromEnvFile(): Promise<string | undefined> {
  try {
    const raw = await readFile(join(getOmniRouteVendorDir(), ".env"), "utf8");
    return raw.match(/^INITIAL_PASSWORD=(.*)$/m)?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function checkKeyValid(base: string, key: string): Promise<boolean> {
  try {
    const res = await bootstrapFetch(`${base}/api/combos`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

function extractAuthTokenCookie(res: Response): string | undefined {
  const headersWithSetCookie = res.headers as Headers & { getSetCookie?: () => string[] };
  const cookies =
    typeof headersWithSetCookie.getSetCookie === "function"
      ? headersWithSetCookie.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""].filter(Boolean);
  for (const cookie of cookies) {
    const match = cookie.match(/(?:^|;\s*)auth_token=([^;]+)/);
    if (match) return match[1];
  }
  return undefined;
}

async function loginForSessionCookie(base: string, password: string): Promise<string | undefined> {
  const res = await bootstrapFetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) return undefined;
  return extractAuthTokenCookie(res);
}

async function mintKey(base: string, authHeaders: Record<string, string>): Promise<CreatedKey | undefined> {
  const res = await bootstrapFetch(`${base}/api/keys`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ name: "mywayai", scopes: ["manage"] }),
  });
  if (!res.ok) return undefined;
  const data = (await res.json()) as { key?: string; id?: string };
  return data.key && data.id ? { key: data.key, id: data.id } : undefined;
}

// The unauthenticated mint above (used only when OmniRoute has no password
// configured) is fast and reliable. The authenticated mint below has been
// observed to hang for the full BOOTSTRAP_FETCH_TIMEOUT_MS against a live
// OmniRoute instance in some environments — reproduced identically via curl,
// Bun fetch, and a real browser (rules out any client-side cause), and via
// both cookie-session auth and OmniRoute's own machine-id CLI-token header
// (rules out cookie/JWT handling specifically). The failure is isolated to
// `POST /api/keys` reached through any non-401 auth path — other
// authenticated routes (key regenerate, combo listing) are unaffected.
// Root cause is inside vendor/omniroute, which is never patched here; retry
// with backoff rather than failing the whole bootstrap on one slow attempt.
const MINT_RETRY_ATTEMPTS = 2;
const MINT_RETRY_DELAY_MS = 3_000;

export interface ProvisionKeyOptions {
  port?: number;
}

export async function provisionKey(opts: ProvisionKeyOptions = {}): Promise<string> {
  const base = omniRouteBaseUrl(opts.port);

  const envOverride = process.env.MYWAYAI_OMNIROUTE_KEY;
  if (envOverride) {
    await persistKey(envOverride);
    return envOverride;
  }

  const existing = await readKeyFile();
  if (existing && (await checkKeyValid(base, existing))) {
    return existing;
  }

  const unauthed = await mintKey(base, {});
  if (unauthed) {
    await persistKey(unauthed.key, unauthed.id);
    return unauthed.key;
  }

  const password = (await readInitialPasswordFromEnvFile()) ?? "CHANGEME";
  const cookie = await loginForSessionCookie(base, password);
  if (!cookie) {
    throw new Error(
      `OmniRoute requires dashboard authentication and the bootstrap login failed (tried the ` +
        `INITIAL_PASSWORD from vendor/omniroute/.env). Create a manage-scope API key from the ` +
        `dashboard (${base}) and re-run with MYWAYAI_OMNIROUTE_KEY=<key> set.`,
    );
  }

  let minted: CreatedKey | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MINT_RETRY_ATTEMPTS; attempt++) {
    try {
      minted = await mintKey(base, { Cookie: `auth_token=${cookie}` });
      if (minted) break;
      lastError = new Error("mintKey returned no key/id data");
    } catch (err) {
      lastError = err;
    }
    if (attempt < MINT_RETRY_ATTEMPTS) await Bun.sleep(MINT_RETRY_DELAY_MS);
  }
  if (!minted) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      `Logged into OmniRoute but key creation still failed after ${MINT_RETRY_ATTEMPTS} attempts: ${detail}. ` +
        `Create a manage-scope API key from the dashboard (${base}) and re-run with ` +
        `MYWAYAI_OMNIROUTE_KEY=<key> set, or retry \`mywayai up\`.`,
    );
  }
  await persistKey(minted.key, minted.id);
  return minted.key;
}

export async function rotateKey(opts: ProvisionKeyOptions = {}): Promise<string> {
  const base = omniRouteBaseUrl(opts.port);
  const id = await readKeyIdFile();
  const key = await readKeyFile();
  if (!id || !key) {
    throw new Error("No existing OmniRoute key/id on disk — run provisionKey() first.");
  }

  const res = await bootstrapFetch(`${base}/api/keys/${id}/regenerate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
  });

  if (res.ok) {
    const data = (await res.json()) as { key?: string; id?: string };
    if (data.key) {
      await persistKey(data.key, data.id ?? id);
      return data.key;
    }
  }

  // Fallback: regenerate route rejected the request or masked the key —
  // mint a fresh key and leave the old one active (documented degradation).
  const minted = await mintKey(base, { Authorization: `Bearer ${key}` });
  if (!minted) {
    throw new Error(`Failed to rotate OmniRoute key (regenerate status ${res.status}) and fallback mint also failed.`);
  }
  await persistKey(minted.key, minted.id);
  return minted.key;
}
