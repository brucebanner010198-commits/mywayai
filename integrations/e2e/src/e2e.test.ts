// Full-stack smoke test: boots the real vendored OmniRoute server, the mock
// provider, provisions a key through the real cookie-bootstrap flow, seeds a
// mock combo, writes omp's config, and makes a real chat-completions request
// through OmniRoute to the mock provider — proving the whole integration
// chain (bridge -> OmniRoute -> combo routing -> provider) works end to end.
//
// Runs against isolated state (MYWAYAI_STATE_DIR / PI_CODING_AGENT_DIR /
// OMNIROUTE_PORT / MOCK_PORT all redirected to a temp dir + unused ports) so
// it never touches a developer's real ~/.mywayai or ~/.omp/agent, and can run
// alongside a locally-running `mywayai up` without port clashes.
//
// Known limitation (documented in docs/architecture.md "Known issues"): the
// cookie-authenticated bootstrap step (provisionKey's login -> mint-with-cookie
// path) has been observed to hang for the full BOOTSTRAP_FETCH_TIMEOUT_MS in
// some sandboxed environments, reproduced identically across curl, Bun fetch,
// and a real browser — a server-side OmniRoute behavior outside this repo's
// control. provisionKey() already retries; this test's timeout accounts for
// the worst case (2 attempts x 20s + backoff) on top of server boot time.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  MOCK_COMBO_NAME,
  provisionKey,
  seedMock,
  startOmniRoute,
  stopOmniRoute,
  writeModelsYaml,
  writeRoleMapping,
} from "@mywayai/omniroute-bridge";
import { serve } from "../../../infra/mock-provider/server.ts";

const OMNIROUTE_PORT = 20_228;
const MOCK_PORT = 9_099;

let stateDir: string;
let agentDir: string;
let mockServer: Bun.Server<undefined> | undefined;

beforeAll(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "mywayai-e2e-state-"));
  agentDir = await mkdtemp(join(tmpdir(), "mywayai-e2e-agent-"));
  process.env.MYWAYAI_STATE_DIR = stateDir;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.OMNIROUTE_PORT = String(OMNIROUTE_PORT);
  process.env.MOCK_PORT = String(MOCK_PORT);

  mockServer = serve(MOCK_PORT);

  await startOmniRoute({ port: OMNIROUTE_PORT, nodeBinDir: process.env.MYWAYAI_NODE_BIN_DIR });
}, 130_000);

afterAll(async () => {
  await stopOmniRoute();
  mockServer?.stop(true);
  await rm(stateDir, { recursive: true, force: true });
  await rm(agentDir, { recursive: true, force: true });
});

test(
  "provisions a key, seeds a mock combo, and routes a real chat request through OmniRoute",
  async () => {
    const key = await provisionKey({ port: OMNIROUTE_PORT });
    expect(key.length).toBeGreaterThan(0);

    await seedMock({ port: OMNIROUTE_PORT, mockPort: MOCK_PORT });
    await writeModelsYaml({ port: OMNIROUTE_PORT });
    await writeRoleMapping({ task: MOCK_COMBO_NAME }, { port: OMNIROUTE_PORT });

    const res = await fetch(`http://localhost:${OMNIROUTE_PORT}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MOCK_COMBO_NAME,
        stream: false,
        messages: [{ role: "user", content: "hello from e2e" }],
      }),
      keepalive: false,
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(data.choices[0]?.message.content).toBe("MOCK-ECHO:hello from e2e");
  },
  90_000,
);
