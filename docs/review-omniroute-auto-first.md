# Code Review — mywayai (OmniRoute + oh-my-pi integration)

Reviewed by: `reviewer` subagent (dispatched 2026-07-09), grounded against source at the commit checked out that day.

**Verdict:** The bridge is solid engineering but delivers the wrong default. Today it is a **static-combo-first** tool wearing an auto-routing README; it does not yet implement the actual ask — **OmniRoute automatic routing as the default, manual oh-my-pi-style pinning as the explicit fallback**.

> **Direction accepted:** the auto-route-first / pin-as-fallback contract
> this review recommends is now the formal decision in
> `docs/adr/0003-auto-routing-first.md`, which also adds a native (omp-side)
> fallback for when OmniRoute itself is unreachable, and a firmed-up
> role→auto-target table (e.g. `advisor`/`plan` → `auto/reasoning:pro`).
> The findings below remain valid as line-level diagnosis of the current
> code; treat the ADR as the target, this doc as the evidence trail.

---

## Finding 1 — Auto-route-first is the core missing product contract
**Severity: P0 — blocks the main value proposition**

- `integrations/omniroute-bridge/src/roles.ts:37-56` — `writeRoleMapping()` requires every role to point at one pre-existing named combo, fetched and validated against `/api/combos`. There is no "let OmniRoute decide" option.
- `roles.ts:63-65` always writes `modelRoles[role] = "omniroute/${comboName}"` — a fixed string, no strategy field.
- `integrations/omp-omniroute-extension/src/extension.ts:570-579` — the `omni_switch_combo` agent tool takes only `role` + `combo`. Same story live, in-session.
- **Correction to the initial hypothesis:** `complexityAwareRouting` / `manifestRouting` are **not live** in this vendored OmniRoute snapshot — `vendor/omniroute/src/lib/db/migrations/103_strip_legacy_combo_config_keys.sql` strips them as legacy keys on save. Not usable.
- The real vendor-native auto surface is different: `vendor/omniroute/src/app/api/v1/models/catalog.ts:448-488` advertises virtual `auto/*` model ids through `/v1/models`, and `vendor/omniroute/src/app/a2a/route.ts:135-158` + `vendor/omniroute/src/lib/a2a/skills/smartRouting.ts:35-48` default A2A calls to a `smart-routing` skill sending `model: "auto"` to `/v1/chat/completions` — but this A2A path isn't wired into omp's `providers.omniroute` flow at all.

**Recommendation:** Reserve auto-target sentinels (`auto`, `auto/coding`, `auto/reasoning`, `auto/vision`, ...) mapped as `omniroute/<auto-target>`; make `roles.ts`/`extension.ts` validation skip the `/api/combos` existence check for anything matching the reserved prefix (validate against `/api/v1/models` instead); default bootstrap to `default → omniroute/auto`, `task → omniroute/auto/coding`, `plan/advisor → omniroute/auto/reasoning`, `vision → omniroute/auto/vision`. Keep `/omni role <role> <combo>` / `omni_switch_combo` as the explicit pin, but rename the UX so priority is unambiguous: `/omni role auto <role> [auto-target]` (default) vs. `/omni role pin <role> <combo>` (fallback). Update `docs/architecture.md`'s data-flow diagram and `docs/quickstart.md` to lead with auto, not a manual combo. A structured `strategy: auto|pinned` field would be cleaner but only works if omp's `modelRoles` schema accepts non-string values (unverified) — the reserved-string sentinel is the safe minimal cutover.

## Finding 2 — Bare `mywayai` currently exits instead of launching anything
**Severity: P1 — high-impact UX gap, directly contradicts "just type mywayai and press enter"**

- `integrations/launcher/src/cli.ts:199-218` — no-arg invocation prints plain `console.error` usage text and `process.exit(1)`.
- `cli.ts:221-241` — `main()`'s switch has no `case undefined`; falls to `default: usage()`.
- The actual interactive path (`cmdUp` → boot OmniRoute → `exec` omp, `cli.ts:134-140`) is only reached via the explicit `up` subcommand.
- `integrations/launcher/package.json:12-20` — zero TUI/animation deps (no ink/chalk/ora); nothing to build an animated interface with today.

**Recommendation:** Make no-args the entrypoint before any visual polish: `command === undefined` → `cmdUp(parseArgs([]))`, optionally preceded by a small ANSI banner/status line. Keep `mywayai up` as an explicit alias. Don't build an independent TUI competing with omp's own terminal UI — reuse omp SDK primitives if exposed, otherwise keep the launcher as a thin preflight/splash layer before `exec`.

## Finding 3 — No onboarding interview exists anywhere
**Severity: P1 — required for the "grill me" experience requested**

- Repo-wide grep for `interview|clarify|onboard|ask.?question|first.?run` in `integrations/`: zero hits.
- `cli.ts:119-131` (`bootOmniRouteAndExtension`) builds/boots/keys/seeds/writes-models/installs-extension and returns — never inspects whether `modelRoles` is empty or prompts anything.
- `extension.ts:452-464` — the full `/omni` subcommand list has no `setup`, `wizard`, or `profile` command.
- `docs/quickstart.md:83-100` assumes the user already knows role names, combo names, and runs `/omni role default test-combo` by hand.

**Recommendation:** One real setup surface, not cosmetic copy: `/omni setup` in-session, plus an optional first-run launcher prompt when `~/.omp/agent/config.yml` has no OmniRoute `modelRoles`. It must actually **write** config: per-role strategy (auto by default), preferred auto-target per role, any explicit pins, and a recommended tool profile — persisted through the same writer the launcher/extension already use. An interview that doesn't change `modelRoles` is theater.

## Finding 4 — No security/frontend/backend/full-stack tool bundle ships
**Severity: P2 — scope decision, not a defect in the bridge itself**

- `extension.ts:504-535` registers exactly two commands (`/omni`, `/remote`); `extension.ts:558-596` registers exactly two agent tools (`omni_usage`, `omni_switch_combo`).
- Nothing under `integrations/` is a skill/tool pack; `README.md:11-17` describes only the bridge/extension/launcher/e2e/infra scope.

**Recommendation — needs a decision, not just code:** don't vendor scanners/framework helpers into this repo (maintenance sprawl, off-mission). Instead, this repo owns bootstrap + routing strategy + a **curated installer**: `mywayai setup` / `/omni setup` recommends/installs `security`, `frontend`, `backend`, `fullstack` profiles from elsewhere, documented in `docs/quickstart.md`, with status surfaced via `/omni tools`. State this boundary explicitly in the docs.

## Finding 5 — Extension-side role writes are less safe than the bridge's
**Severity: P2 — incidental correctness issue, found while reading for Finding 1**

- `roles.ts:59-68` writes via `atomicWriteFile`. `extension.ts:143-158` (and live call sites `:432-440`, `:585-591`) perform the identical `config.yml` update but via plain `Bun.write`, not atomic.
- Direct consequence of the deliberate roles/keys duplication documented in `docs/architecture.md` — not already tracked in `docs/resilience-review.md`.

**Recommendation:** Port the atomic-write behavior into the extension (or factor a tiny dependency-free writer both bundles include) while already touching this code for Finding 1's auto/pin rework. Update the duplication comment to spell out exactly which invariants (valid roles, auto-target allowlist, combo-validation source, atomic write) must stay in sync between the two copies.

---

## Prioritized punch-list for an implementer

1. **Routing contract** — reserved `omniroute/auto*` targets as default per role in `roles.ts` + `extension.ts`; explicit pin is the fallback. Do not build on `complexityAwareRouting`/`manifestRouting` — confirmed dead in this vendor snapshot.
2. **UX language** — `/omni role auto <role> [target]` vs. `/omni role pin <role> <combo>`; same split on the `omni_switch_combo` tool schema.
3. **`mywayai` with no args boots the product** — route to `cmdUp` by default in `cli.ts`, add a lightweight banner.
4. **Real setup/interview flow** that writes strategy + auto-target + pin + tool-profile choices, not decorative Q&A.
5. **State the tool-bundle boundary explicitly** — this repo curates/installs; it doesn't vendor scanners and framework helpers itself.
6. **Fix the extension's non-atomic config write** while the role-mapping code is being touched anyway.
