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
