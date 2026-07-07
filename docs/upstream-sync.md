# Upstream sync

Both `vendor/omniroute` and `vendor/oh-my-pi` are `git subtree --squash`
pulls from their respective upstreams. Neither is ever hand-edited — any fix
or customization belongs in `integrations/` or `infra/`, never in `vendor/`.

## Remotes

Set up once per clone (already configured if you cloned this repo with its
existing remotes intact):

```sh
git remote add omniroute-upstream https://github.com/diegosouzapw/OmniRoute
git remote add omp-upstream https://github.com/can1357/oh-my-pi
```

## Pulling manually

```sh
make sync-upstreams
# or directly:
./scripts/subtree-pull.sh
```

This runs, for each vendor:

```sh
git subtree pull --prefix vendor/<name> <remote> main --squash
```

Each pull produces one squash-merge commit per vendor (two commits total per
sync run) — review each independently; they are never combined.

## Automated sync (CI)

`.github/workflows/sync-upstreams.yml` runs this daily (06:00 UTC) and on
manual dispatch. It pulls both upstreams on a fresh branch, and if either
produced a change, opens a PR titled `chore: sync upstreams (<date>)`. CI
(`ci.yml` — typecheck + `make e2e`) must pass on that PR before merging, same
as any other change.

If a subtree pull hits a merge conflict, the workflow fails loudly (matching
`scripts/subtree-pull.sh`'s own contract: "fails loudly on conflict") and
**no PR is opened** for that run — resolve manually per the next section,
then either push the resolution directly or re-trigger the workflow.

## Resolving a conflict

A `git subtree pull --squash` conflict resolves like a normal merge conflict:

1. Resolve the conflicting files in place (they'll be under `vendor/<name>/`).
2. `git add` the resolved paths.
3. `git commit` to finish the merge — this completes the squash-merge commit
   the subtree pull started.
4. Re-run the *other* vendor's pull if `scripts/subtree-pull.sh` aborted
   before reaching it (the script runs OmniRoute first, then oh-my-pi; a
   conflict in the first one blocks the second within that invocation).

After resolving, re-run the checks that matter for what changed:

- `vendor/omniroute` changed → `make build-omniroute && make e2e`
- `vendor/oh-my-pi` changed → typecheck `integrations/omp-omniroute-extension`
  and `integrations/launcher` (both depend on `@oh-my-pi/pi-coding-agent`'s
  published types, which may have shifted) — `make e2e` also exercises the
  extension's build.

## Version pins to watch

- `integrations/launcher/package.json` and
  `integrations/omp-omniroute-extension/package.json` pin
  `@oh-my-pi/pi-coding-agent` to an exact version (currently `16.3.11`,
  checked live against `npm view @oh-my-pi/pi-coding-agent versions --json`
  at the time this was set) — a vendored `oh-my-pi` bump does not
  automatically bump the *published npm package* these two consume for
  build-time types. If a subtree sync brings in an incompatible SDK surface
  (extension registration API, tool schema shape), bump this pin
  deliberately and re-typecheck.
- OmniRoute's `package.json` `engines.node` (`>=22.0.0 <25.0.0` as of this
  writing) gates which Node version `.github/workflows/ci.yml`'s
  `OMNIROUTE_NODE_VERSION` and `docs/quickstart.md`'s prerequisites reference
  — bump all three together if a sync changes the range.
