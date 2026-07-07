---
status: accepted
date: 2026-07-07
decision: "omp-style hybrid; repo-clone retained as dev mode; Docker retained for CI"
---

## Distribution & lifecycle — can mywayai adopt the omp / Oh-My-Posh model?

### How the references actually work (verified in-tree)
- **omp** (`vendor/oh-my-pi/scripts/install.sh`, README:33-53): four install channels — `curl https://omp.sh/install | sh` (drops a prebuilt binary into `~/.local/bin`, or bootstraps Bun for source installs), Homebrew tap, `bun install -g @oh-my-pi/pi-coding-agent`, PowerShell script. The product is a **self-contained Bun-runnable package/binary**; lifecycle = replace one artifact.
- **Oh My Posh** (the prompt tool): single static Go binary per platform, installed to a user dir, shell-init one-liner, `oh-my-posh upgrade` self-update. Same shape: one artifact, no toolchain.

### Why mywayai cannot copy either wholesale
mywayai's payload is not one binary. It is (a) a thin Bun launcher (portable — this part *can* be omp-shaped), plus (b) **OmniRoute: a Next.js server** requiring Node `>=22 <25`, a ~10-minute `npm ci && npm run build`, and native modules (`better-sqlite3`, per `run-next.mjs`'s `ensureNativeSqlite`). No single-binary compile path exists for it. The lifecycle question is therefore: *how do users obtain a runnable OmniRoute build without the repo and the 10-minute toolchain dance?*

### Options compared

| | A: repo-clone (status quo) | B: omp-style hybrid (chosen) | C: Docker-first |
|---|---|---|---|
| Install | git clone + bun + node@22-24 + 10 min build | `curl \| sh` or `bun i -g`; first `up` downloads a prebuilt OmniRoute tarball (~1 min) | `bun i -g` + Docker pull |
| Update | `mywayai sync` + rebuild | `mywayai upgrade` swaps artifact | image pull |
| Toolchain burden | Bun + exact Node range + build RAM | Bun + a Node runtime to *run* (no build) | Docker only |
| Native deps | built locally (robust) | must ship per-OS/arch artifacts (macOS arm64/x64, linux x64/arm64) | solved by image |
| Key bootstrap | localhost, as today | unchanged | container networking nuance (still localhost via port publish) |
| Fresh-vendor currency | daily subtree sync, local rebuild | release cadence = CI builds on each merged sync PR | same |
| Failure modes added | — | download/checksum/rate-limit failures; per-platform build matrix drift | Docker daemon absent/broken |
| DX for contributors | best | keep repo mode as dev path | worst for hacking on vendor |

**Recommendation (matches user's choice): B**, with A retained as the contributor path and C's compose file retained as-is for CI/self-hosters. B mirrors Oh-My-Posh's lifecycle as closely as the Next.js payload allows: one command install, one command upgrade, no build toolchain, graceful fallback (if the artifact download fails, the launcher prints the repo-clone instructions — degraded but never dead).

### D1 — Release pipeline (order 11, complexity L)
New workflow `.github/workflows/release.yml`, trigger: push of tag `v*` (tags cut manually after a green sync PR merges; **decision:** no auto-tagging — a human gates releases since upstream syncs daily and not every sync deserves a release).
- Matrix `{macos-14 (arm64), macos-13 (x64), ubuntu-latest (x64), ubuntu-24.04-arm (arm64)}` × Node 24: `npm ci && npm run build` in `vendor/omniroute`, then tar `vendor/omniroute/.build/next/standalone`, `.build/next/static`, `public/`, `.env.example`, and the `scripts/dev/run-next.mjs` closure of files it imports (`scripts/dev/*`, `scripts/build/bootstrap-env.mjs`, `scripts/build/runtime-env.mjs` — implementer derives the exact file set by reading `run-next.mjs`'s import graph; if the standalone `server.js` can serve alone without `run-next.mjs`, prefer that and record which env vars replace `bootstrapEnv` — this is the plan's one **investigate-then-decide** step, bounded to choosing between two known launch entrypoints).
- Name artifacts `omniroute-<tag>-<os>-<arch>.tar.gz` + `SHA256SUMS`; attach to the GitHub Release.
- Also build `integrations/omp-omniroute-extension` dist and include it in a `mywayai-<tag>.tar.gz` alongside the launcher.

### D2 — Publishable launcher with `install`/`upgrade` (order 12, complexity M)
- Rename-publish `@mywayai/launcher` → public npm package `mywayai` (bin `mywayai`), bundling the bridge (`bun build --target bun` single file, same trick as the extension — removes the workspace-only `workspace:*` dependency that blocks publishing).
- New path resolution: when `getRepoRoot()`'s `vendor/omniroute` exists (repo checkout) behave exactly as today; otherwise resolve the runtime under `~/.mywayai/versions/<tag>/` with a `~/.mywayai/current` symlink, and `startOmniRoute` spawns from there.
- New commands: `mywayai upgrade` (query the GitHub Releases API for latest, download matching os/arch artifact, verify SHA256, unpack to `versions/<tag>`, atomically repoint `current`, keep the previous version for one-step rollback via `mywayai upgrade --rollback`) and first-run auto-provision inside `up` when no version is installed. All downloads honor `MYWAYAI_RELEASE_BASE_URL` for mirrors/air-gap.
- Failure behavior (per the resilience mandate): download/API failure → keep the currently-installed version working and say so; no version installed and download fails → print the repo-clone fallback verbatim.
- `curl | sh` installer `scripts/install.sh` modeled directly on `vendor/oh-my-pi/scripts/install.sh` (Bun-detect → `bun i -g mywayai`, else brew/binary guidance).

### D3 — Node runtime policy (order 12b, decision recorded)
The prebuilt standalone still needs a Node ≥22 <25 **runtime**. Decision: require system Node (checked at `up` with a clear version error naming `MYWAYAI_NODE_BIN_DIR`), do **not** download a private Node runtime in v1 — it doubles artifact size and failure surface for a constraint most target users (developers) already satisfy. Revisit only if telemetry/issues show it as the top install blocker.
