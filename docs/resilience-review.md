## Fault analysis — findings with evidence

All file references verified this session. Severity: P0 = can damage user state, expose the machine, or fail slowly/confusingly on realistic first-run paths; P1 = degraded UX / operational debt; P2 = design debt & distribution.

### F1 (P0) — OmniRoute binds `0.0.0.0` with a default password
`vendor/omniroute/scripts/dev/run-next.mjs:70`: `const hostname = process.env.HOST || "0.0.0.0"`. The bridge (`integrations/omniroute-bridge/src/server.ts` `startOmniRoute`) sets `PORT` and `DATA_DIR` in the spawn env but **not** `HOST`. Combined with the shipped `INITIAL_PASSWORD=CHANGEME` (`.env.example`, copied by postinstall — documented in `docs/quickstart.md:63-65`), every `mywayai up` exposes an LLM-gateway admin surface with a well-known password to the entire local network. All bridge/extension clients use `http://localhost:...` exclusively (`paths.ts:81-83`), so nothing needs the wide bind. Fix is one env var — no vendor patch.

### F2 (P0) — Child crash produces a 128-second failure with a stale pidfile
`server.ts` `startOmniRoute`: after `Bun.spawn`, it writes the pidfile, sleeps `INITIAL_GRACE_MS` (8 s), then polls for up to `START_TIMEOUT_MS` (120 s). `proc.exited` is never observed. If the child dies instantly — port held by a non-HTTP process, missing/corrupt `.build`, wrong Node version, `npm` not on PATH — the user waits ~128 s for a generic timeout, and the pidfile points at a dead (later possibly recycled) pid. This is the dominant "startup failure" path in real-world conditions.

### F3 (P0) — Pid lifecycle: wrong process recorded, no wait/escalation, pid-reuse kill risk
- The recorded pid is **npm's**, not the server's: `cmd: ["npm", "run", "start"]` → `node scripts/dev/run-next.mjs` runs as npm's child. If npm exits but node survives (or signal forwarding fails), `stopOmniRoute` declares "stale pidfile", deletes it, and the real server keeps holding the port with no management handle left.
- `stopOmniRoute` (`server.ts:139-152`) sends SIGTERM and deletes the pidfile immediately — no wait-for-exit, no SIGKILL escalation. A wedged server (the exact failure mode documented in "Known issues") survives `mywayai down`.
- After a reboot, the pid number can belong to an unrelated process; `isProcessAlive(pid)` + SIGTERM can kill an innocent process. No identity check (start-time, command line, or port ownership) is performed.

### F4 (P0) — Port-squat and unhealthy-server misidentification
`pingOnce` (`server.ts:39-55`) treats **any** HTTP 200/401 on the port as "OmniRoute is up"; `startOmniRoute` then silently reuses it. A foreign service on 20128 yields baffling downstream `provisionKey` errors instead of "port is occupied by something else". Conversely, OmniRoute's own ping returns **503** with `{status:"error",error:"db_query_failed"}` when its DB is broken (`vendor/omniroute/src/app/api/health/ping/route.ts:22-27`) — `pingOnce` maps that to "down", so `startOmniRoute` spawns a second instance against a taken port and dies via F2's slow path. The 200 body is identifiable: `{status:"ok",timestamp,latencyMs}`.

### F5 (P0) — Key management: duplicate-key sprawl, unvalidated overrides, orphaned live keys
`integrations/omniroute-bridge/src/keys.ts`:
- `checkKeyValid` returns `false` on *any* error including timeout/connection failure (`keys.ts:67-76`). A transient network blip during `up` discards a perfectly valid key and mints another "mywayai" key. Old keys stay **active** in OmniRoute — unbounded credential sprawl with security implications.
- `MYWAYAI_OMNIROUTE_KEY` is persisted blindly without validation (`provisionKey`, first branch). A typo'd key produces confusing failures far downstream (omp session errors) instead of an immediate actionable one.
- `rotateKey`'s fallback mints a fresh key and leaves the old one active (commented as "documented degradation") — same sprawl issue, worse because rotation is usually a security response.

### F6 (P0) — User config files: non-atomic writes, comment destruction, bare-tag parse bombs
`models-yaml.ts` / `roles.ts` / `yaml.ts` rewrite the user's `~/.omp/agent/models.yml` and `config.yml` via `Bun.write` — a crash mid-write corrupts omp's primary config. The js-yaml round-trip also **silently strips every user comment and anchor**. Verified live this session: js-yaml `DEFAULT_SCHEMA` **throws** `YAMLException: unknown tag !<!cat>` on a bare (unquoted) `!cat`/`!cmd` value — omp's docs use the quoted form (`apiKey: "!op read ..."`, `vendor/oh-my-pi/docs/models.md:149`) so mainstream configs load, but any hand-edited bare-tag file makes `mywayai up` die with a raw parser stack instead of naming the file and line. No pre-write backup exists.

### F7 (P0) — No concurrency guard on `up`
Two concurrent `mywayai up` invocations (or `up` racing the e2e suite with default paths) both see "down", both spawn; the loser fails via F2's slow path and may overwrite the winner's pidfile. No lockfile exists in the state dir.

### F8 (P1) — Config value validation
`resolveOmniRoutePort` (`paths.ts:75-79`): `OMNIROUTE_PORT=abc` → `Number("abc")` = NaN → every URL becomes `http://localhost:NaN/...`, failing with unrelated fetch errors. Launcher `--port abc` (`cli.ts` `parseArgs`) same; `--port 0` is falsy and silently ignored. `MOCK_PORT` (`seed.ts:72`) same pattern.

### F9 (P1) — Stale extension after repo updates
`ensureExtensionInstalled` (`launcher/src/cli.ts`) builds `dist/omniroute.js` only when the file is **missing**. After `git pull` changes `extension.ts`, users keep running the stale build indefinitely (`bun build` takes well under a second, so caching buys nothing).

### F10 (P1) — Unbounded log growth
`getOmniRouteLogFile()` is opened append-only on every start (`server.ts`, `openSync(..., "a")`); nothing ever rotates or truncates it. Long-lived daily use fills the disk silently.

### F11 (P1) — Shallow `status` and misleading extension errors
- `cmdStatus` reports "up" from the unauthenticated ping alone — a server that answers pings but hangs on real routes (the documented known-issue pattern) reads as healthy.
- The extension's `omni()` helper maps **every** fetch throw — including a 10 s timeout against a live-but-slow server — to "OmniRoute is not running — start it with `mywayai up`" (`extension.ts`, catch → `OmniRouteUnreachableError`). Wrong instruction for the timeout case.

### F12 (P1) — Brittle upstream-shape couplings
- `seed.ts` `ensureTestCombo` matches the exact error string `"Combo name already exists"` — breaks silently on an upstream message change, while the sibling functions (`ensureMockProviderNode`) already use the robust list-then-create pattern.
- `.github/workflows/sync-upstreams.yml`: branch `sync-upstreams-$(date +%Y%m%d)` collides on a same-day re-run (push/PR-create fails after a partially-failed earlier run); `gh pr create` also fails if the PR already exists. Upstream branch name `main` is hard-coded in `scripts/subtree-pull.sh` (acceptable; fails loudly).
- CI cache key hashes every vendored `*.ts/tsx/mjs/cjs` — correct but recomputes slowly; acceptable.

### F13 (P2, noted) — Accepted-risk items, documented not fixed
- `writeModelsYaml` embeds the absolute key-file path at write time; changing `MYWAYAI_STATE_DIR` between runs leaves a stale `!cat` path. Re-running `up` heals it.
- `readInitialPasswordFromEnvFile` goes stale if the user changes the dashboard password — the thrown error already names the `MYWAYAI_OMNIROUTE_KEY` escape hatch.
- POSIX-only lifecycle (`process.kill`, `tail -f`, pidfiles). Windows support is out of scope until the distribution track (below) forces the question.
- The `POST /api/keys` server-side hang is upstream and already well-mitigated (retry + `keepalive: false` + manual-key fallback); the docs/architecture.md writeup is accurate and thorough. No further client-side action is worth its complexity.

## Prioritized improvement plan

Each item: what / why / benefit / complexity / risks / order. Ordering favors: (1) stop damaging or exposing user state, (2) fail fast with truthful errors, (3) operational polish, (4) distribution. Items H1–H4 are independent of each other; H5–H10 are independent of everything except where noted.

### H1 — Bind OmniRoute to localhost (fixes F1) — order 1, complexity XS
In `startOmniRoute`'s spawn env add `HOST: process.env.MYWAYAI_OMNIROUTE_HOST ?? "127.0.0.1"`. `run-next.mjs:70` honors `HOST` verbatim. The env override exists for the rare user who deliberately wants LAN exposure. Benefit: closes a default-password network exposure. Risk: none for the shipped flow (all clients use `localhost`); the docker-compose path is unaffected (its own env). Verify: `mywayai up`, then from another machine (or `curl --interface`) confirm connection refused on the LAN address, success on 127.0.0.1.

### H2 — Fail fast on child death; race readiness against `proc.exited` (fixes F2) — order 2, complexity S
In `startOmniRoute`, keep a `let exited = false; proc.exited.then(() => { exited = true; })` and check it: during the grace sleep (split into 500 ms slices) and at the top of each poll iteration. On `exited === true`: delete the pidfile, read the log tail, throw `OmniRoute exited during startup (code ...)` + tail. Keep the existing timeout branch for the never-came-up case. Benefit: 1–2 s failures instead of 128 s, no stale pidfile. Risk: none — `proc.exited` resolving is unambiguous. Verify: occupy the port with `nc -l` (non-HTTP) → `mywayai up` must fail in seconds naming the exit; delete `.build` marker's target and repeat.

### H3 — Own the process tree; make `down` reliable (fixes F3) — order 3, complexity M
- Replace the bare pidfile with a JSON state file `~/.mywayai/omniroute.state.json` `{ pid, port, startedAt }` (keep writing the legacy pidfile one release for `status` compatibility, then drop it — clean cutover acceptable since both are internal).
- Spawn detached into its own process group (Bun.spawn does not expose `detached`; use `cmd: ["setsid", "npm", "run", "start"]`? **Decision:** no — `setsid` is Linux-only. Instead record npm's pid AND, in `stopOmniRoute`, kill the *group* via `process.kill(-pid, "SIGTERM")` after verifying group ownership; if `-pid` throws ESRCH fall back to `pid`. On macOS/Linux Bun's spawn children share the parent group unless detached, so negative-pid kill from a *different* mywayai invocation is safe: npm becomes a group leader is NOT guaranteed — therefore the load-bearing mechanism is (a) SIGTERM npm's pid (npm forwards to its child), (b) **wait up to 10 s polling `isProcessAlive` + `pingOnce`**, (c) escalate SIGKILL to the pid, (d) if the port still answers after another 5 s, print the exact `lsof -i :<port>` command for manual cleanup and exit non-zero. This keeps behavior correct without platform-specific group plumbing.
- Guard pid reuse: before any kill, require `startedAt` to be within the current boot (compare against `os.uptime()`-derived boot time; if `startedAt < bootTime`, treat as stale, remove state file, never signal).
Benefit: `mywayai down` actually stops wedged servers; no innocent-process kills; no orphaned servers presented as "stale pidfile". Risk: npm's signal forwarding differs across versions — the wait+escalate+verify loop makes forwarding failures visible instead of silent. Verify: `mywayai up`, `kill -STOP` the node child to simulate a wedge, `mywayai down` must escalate and leave the port free; fabricate a state file with `startedAt` before boot and a live foreign pid → `down` must refuse to signal.

### H4 — Identify the server before reusing or declaring health (fixes F4) — order 4, complexity S
In `pingOnce`, on HTTP 200 parse the body and require `status === "ok"` (shape verified at `vendor/omniroute/src/app/api/health/ping/route.ts:28-33`). Return a tri-state from a new `probe(port): "ok" | "unhealthy" | "foreign" | "down"`:
- 200 + `status:"ok"` → ok; 503 + JSON `status:"error"` → unhealthy (server is OmniRoute but broken: **fail `up` immediately** with the log-tail error, do not spawn a second instance); 401 → check the body/headers are JSON (the middleware's 401 shape — implementer confirms with `grep -rn "401" vendor/omniroute/src/lib/middleware/` and matches on JSON content-type as the minimum bar) → ok-preauth; anything else (HTML from a random dev server, non-JSON) → foreign → `up` errors: `Port <p> is answering HTTP but does not look like OmniRoute — choose another port with --port or stop the other service.`
`isUp()` keeps its boolean contract (`ok || ok-preauth`). Benefit: truthful startup errors; never double-spawns onto a broken instance. Risk: upstream could change the ping body — the `foreign` branch then misfires; mitigate by treating `unknown-JSON-200` as ok with a warning rather than foreign (decision: JSON 200/401 = assume OmniRoute; non-JSON = foreign). Verify: run `python3 -m http.server 20128` → `mywayai up` names the foreign service; normal path unchanged (e2e green).

### H5 — Key hygiene (fixes F5) — order 5, complexity S
- `checkKeyValid` → return tri-state: 200 valid; 401/403 invalid; anything else/thrown → `unknown`. In `provisionKey`, on `unknown` **throw** (`Could not verify the existing OmniRoute key (network error): <detail>. OmniRoute may still be starting — retry, or remove <keyfile> to force re-provisioning.`) instead of minting.
- Validate `MYWAYAI_OMNIROUTE_KEY` with the same check before persisting; on invalid, throw naming the env var; on `unknown`, throw the network message.
- Name minted keys `mywayai-<hostname>-<yyyymmdd>` instead of the constant `mywayai` so sprawl is at least attributable; after a successful mint in `provisionKey`, best-effort `DELETE /api/keys/:id` the previous `readKeyIdFile()` id (implementer confirms the delete route exists via `glob vendor/omniroute/src/app/api/keys/**/route.ts` and reads its method; if no DELETE exists, skip deletion and log the old id). Same best-effort delete in `rotateKey`'s fallback branch.
Benefit: no silent credential sprawl, immediate feedback on bad overrides. Risk: the stricter `unknown` path can fail an `up` that previously "worked" by minting a duplicate — that is the intended trade (correctness over silent accumulation). Verify: e2e still green; set `MYWAYAI_OMNIROUTE_KEY=garbage` → fast, named failure.

### H6 — Safe config-file writes (fixes F6) — order 6, complexity S
In a single shared helper (extend `yaml.ts` with `saveYamlDoc(path, doc)` used by `models-yaml.ts`, `roles.ts`, and duplicated ~10 lines into `extension.ts` per the existing standalone-bundle rule):
- Write to `<path>.tmp.<pid>` then `rename` over the target (atomic on POSIX).
- Before the first write of a run, copy the existing file to `<path>.bak` (single rolling backup).
- Wrap `yaml.load` failures with the filename + js-yaml's mark line/column and the sentence `mywayai will not modify a file it cannot parse — fix the YAML (or restore <path>.bak) and re-run.`
- Document (in the report and quickstart) that comments in `models.yml`/`config.yml` are not preserved by mywayai's writers — preserving them means swapping js-yaml for a CST-preserving parser (`yaml` package) across bridge + extension; **decision: defer**, the `.bak` copy is the cheap insurance now.
Benefit: crash-safe writes, recoverable mistakes, actionable parse errors. Risk: none material. Verify: `writeModelsYaml` against a deliberately broken YAML must throw the friendly error and leave the file untouched; kill -9 mid-write cannot corrupt (tmp+rename).

### H7 — `up` lockfile (fixes F7) — order 7, complexity XS
`openSync(join(getStateDir(),"up.lock"), "wx")` at `cmdUp` start, containing the pid; on EEXIST read the pid — if alive, exit with `another mywayai up (pid N) is running`; if dead, remove and retake. Release in a `finally`. Benefit: removes the double-spawn race. Verify: two concurrent `up` runs — second exits immediately with the message.

### H8 — Validate ports and numeric config (fixes F8) — order 8, complexity XS
`resolveOmniRoutePort`: parse with `Number.parseInt`, require integer 1–65535, else throw naming the source (`OMNIROUTE_PORT`/`--port`). Same for `--port` in both CLIs and `MOCK_PORT` in `seed.ts`. Verify: `OMNIROUTE_PORT=abc mywayai status` → immediate named error.

### H9 — Always rebuild the extension; rotate logs (fixes F9, F10) — order 9, complexity XS
- `ensureExtensionInstalled`: drop the `existsSync(distFile)` short-circuit — always `bun build` (sub-second), then copy. (No mtime dance; simplicity is the reliability feature here.)
- `startOmniRoute`: before `openSync`, if the log file exceeds 10 MB rename it to `omniroute.log.1` (overwriting any previous `.1`).
Verify: touch `extension.ts`, `mywayai up`, installed file's content hash changes; create an 11 MB log, `up` rotates it.

### H10 — Truthful status & extension errors; robust seeding; sync-workflow fixes (fixes F11, F12) — order 10, complexity S
- `cmdStatus`: after the ping, if a key exists run `checkKeyValid`-style `GET /api/combos`; print `up (serviceable)` / `up (ping only — admin API not responding or key invalid)` / `down`, plus port and state-file pid.
- Extension `omni()`: catch branch distinguishes `err.name === "TimeoutError" || err.name === "AbortError"` → `OmniRoute did not answer within 10s — it may be overloaded or wedged; try again or restart with mywayai down && mywayai up.` from connection errors (current message).
- `seed.ts` `ensureTestCombo`: list combos first (`GET /api/combos`, same pattern as `ensureMockProviderNode`), skip POST if `MOCK_COMBO_NAME` exists; delete the error-string match.
- `sync-upstreams.yml`: branch name → `sync-upstreams-${{ github.run_id }}`; before `gh pr create`, `gh pr list --head <branch>` guard (or tolerate the create failure when a PR exists with `|| true` **only** on the exact already-exists error — decision: use `gh pr create ... || gh pr list --head "$BRANCH" --json url -q '.[0].url'` so the step succeeds iff a PR exists).
Verify: stop OmniRoute mid-session and run `/omni combos` (connection message) vs `kill -STOP` it (timeout message); re-run seed twice (idempotent, no string match); dispatch the sync workflow twice same day (both succeed).
