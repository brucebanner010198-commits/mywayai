SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c

# Optional: prepend a directory (e.g. a keg-only `node@24` install) to PATH
# for OmniRoute's npm/node commands, without touching the caller's global
# node. Example:
#   make build-omniroute NODE_BIN_DIR=/opt/homebrew/opt/node@24/bin
NODE_BIN_DIR ?=
ifneq ($(NODE_BIN_DIR),)
export PATH := $(NODE_BIN_DIR):$(PATH)
endif

.PHONY: install build-omniroute dev e2e sync-upstreams

install:
	bun install

build-omniroute:
	cd vendor/omniroute && npm ci
	cd vendor/omniroute && NODE_OPTIONS=--max-old-space-size=4096 npm run build

dev:
	bun run --cwd integrations/launcher src/cli.ts up --seed-mock

e2e:
	bun test integrations/e2e

sync-upstreams:
	./scripts/subtree-pull.sh
