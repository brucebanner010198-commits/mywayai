#!/usr/bin/env bash
set -euo pipefail

# Pull the latest `main` from both upstreams into their vendored subtrees.
# Fails loudly on conflict — resolve manually per docs/upstream-sync.md,
# then `git add` the resolved paths and `git commit` to finish the merge.

cd "$(git rev-parse --show-toplevel)"

echo "==> Pulling vendor/omniroute from omniroute-upstream/main"
git subtree pull --prefix vendor/omniroute omniroute-upstream main --squash

echo "==> Pulling vendor/oh-my-pi from omp-upstream/main"
git subtree pull --prefix vendor/oh-my-pi omp-upstream main --squash

echo "==> Done. Review changes with: git log --oneline -5"
