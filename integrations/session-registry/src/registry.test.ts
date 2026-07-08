// Verifies the two properties docs/adr/0002-remote-control.md requires of
// the registry: concurrent writers never interleave into a corrupt/partial
// file, and dead entries (by pid or staleness) are pruned rather than
// lingering as dead RCE-capable links.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readRegistry, upsertRegistryEntry } from "./registry.ts";
import type { SessionEntry } from "./types.ts";

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "session-registry-test-"));
  process.env.MYWAYAI_STATE_DIR = stateDir;
});

afterEach(async () => {
  delete process.env.MYWAYAI_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
});

function entry(id: string): SessionEntry {
  return { id, name: id, cwd: "/tmp", link: `link-${id}`, lastActiveAt: new Date().toISOString(), pid: process.pid };
}

test("concurrent upserts from many callers all survive — no lost updates from unlocked read-modify-write", async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `session-${i}`);
  await Promise.all(ids.map((id) => upsertRegistryEntry(entry(id))));

  const final = await readRegistry();
  expect(final).toHaveLength(ids.length);
  expect(new Set(final.map((e) => e.id))).toEqual(new Set(ids));
});

test("re-registering the same id updates in place rather than duplicating", async () => {
  await upsertRegistryEntry(entry("same"));
  const updated = { ...entry("same"), name: "renamed" };
  await upsertRegistryEntry(updated);

  const final = await readRegistry();
  expect(final).toHaveLength(1);
  expect(final[0]?.name).toBe("renamed");
});

test("an entry with a dead pid is pruned on the next upsert", async () => {
  // A pid essentially guaranteed not to be alive.
  const dead: SessionEntry = { ...entry("dead"), pid: 2_147_483_647 };
  await upsertRegistryEntry(dead);
  expect(await readRegistry()).toHaveLength(1);

  await upsertRegistryEntry(entry("alive"));
  const final = await readRegistry();
  expect(final.map((e) => e.id)).toEqual(["alive"]);
});

test("a live pid with a stale lastActiveAt is pruned (guards against pid recycling)", async () => {
  const stale: SessionEntry = { ...entry("stale"), lastActiveAt: new Date(Date.now() - 10 * 60_000).toISOString() };
  await upsertRegistryEntry(stale);
  expect(await readRegistry()).toHaveLength(1);

  await upsertRegistryEntry(entry("fresh"));
  const final = await readRegistry();
  expect(final.map((e) => e.id)).toEqual(["fresh"]);
});
