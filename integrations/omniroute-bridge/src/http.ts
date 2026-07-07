// Shared fetch wrapper for every OmniRoute admin/bootstrap call.
//
// `keepalive: false` is load-bearing, not cosmetic: Bun's fetch reuses
// keep-alive connections across calls from the same process, and reusing one
// against this server hangs indefinitely (observed live, reproduced via bare
// `curl` too) even though a fresh connection gets an instant response. Every
// bootstrap call must go through this wrapper.

import { BOOTSTRAP_FETCH_TIMEOUT_MS } from "./paths.ts";

export async function bootstrapFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    keepalive: false,
    signal: init.signal ?? AbortSignal.timeout(BOOTSTRAP_FETCH_TIMEOUT_MS),
  });
}

/** Authenticated JSON call: adds Bearer key + JSON content-type, throws a formatted error on non-2xx. */
export async function authedJson<T>(base: string, key: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await bootstrapFetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", Authorization: `Bearer ${key}`, ...init.headers },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OmniRoute request failed: ${init.method ?? "GET"} ${path} -> ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}
