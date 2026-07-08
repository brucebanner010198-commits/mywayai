// Seeds OmniRoute with a mock provider node/connection/combo so dev and e2e
// runs have something to route through without a real upstream provider.
// Never called by `mywayai up` unless `--seed-mock` is passed.

import { authedJson, bootstrapFetch } from "./http.ts";
import { omniRouteBaseUrl } from "./paths.ts";
import { requireKey } from "./keys.ts";

export const MOCK_PREFIX = "mock";
export const MOCK_COMBO_NAME = "test-combo";

interface ProviderNode {
  id: string;
  prefix?: string;
  baseUrl?: string;
}

interface ProviderConnection {
  provider: string;
}

async function ensureMockProviderNode(base: string, key: string, mockPort: number): Promise<string> {
  const { nodes } = await authedJson<{ nodes: ProviderNode[] }>(base, key, "/api/provider-nodes");
  const existing = nodes.find((n) => n.prefix === MOCK_PREFIX);
  if (existing) {
    const expected = `http://localhost:${mockPort}/v1`;
    if (existing.baseUrl && existing.baseUrl !== expected) {
      throw new Error(
        `Refusing to seed: a provider node with prefix "mock" already exists but points at ${existing.baseUrl}, not the local mock (${expected}). Remove it or use a fresh OMNIROUTE state dir.`,
      );
    }
    return existing.id;
  }

  const { node } = await authedJson<{ node: ProviderNode }>(base, key, "/api/provider-nodes", {
    method: "POST",
    body: JSON.stringify({
      name: "Mock Provider",
      prefix: MOCK_PREFIX,
      apiType: "chat",
      baseUrl: `http://localhost:${mockPort}/v1`,
      type: "openai-compatible",
    }),
  });
  return node.id;
}

async function ensureMockProviderConnection(base: string, key: string, nodeId: string): Promise<void> {
  const { connections } = await authedJson<{ connections: ProviderConnection[] }>(base, key, "/api/providers");
  if (connections.some((c) => c.provider === nodeId)) return;

  await authedJson(base, key, "/api/providers", {
    method: "POST",
    body: JSON.stringify({ provider: nodeId, name: "mock-conn", apiKey: "mock-secret" }),
  });
}

async function ensureTestCombo(base: string, key: string): Promise<void> {
  const res = await bootstrapFetch(`${base}/api/combos`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ name: MOCK_COMBO_NAME, models: [`${MOCK_PREFIX}/mock-gpt`], strategy: "priority" }),
  });
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 400 && body.error === "Combo name already exists") return;
  throw new Error(`Failed to create combo "${MOCK_COMBO_NAME}": ${res.status} ${JSON.stringify(body)}`);
}

export interface SeedMockOptions {
  port?: number;
  mockPort?: number;
}

export async function seedMock(opts: SeedMockOptions = {}): Promise<void> {
  const base = omniRouteBaseUrl(opts.port);
  const mockPort = opts.mockPort ?? Number(process.env.MOCK_PORT ?? 9999);
  const key = await requireKey();

  const nodeId = await ensureMockProviderNode(base, key, mockPort);
  await ensureMockProviderConnection(base, key, nodeId);
  await ensureTestCombo(base, key);
}
