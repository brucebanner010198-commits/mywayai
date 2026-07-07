# mywayai

A super-repository that deeply integrates **[OmniRoute](https://github.com/diegosouzapw/OmniRoute)** (self-hosted LLM gateway — combos, quota, fallback, usage analytics) with **[oh-my-pi / omp](https://github.com/can1357/oh-my-pi)** (Bun terminal coding agent, published as [`@oh-my-pi/pi-coding-agent`](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent)).

omp is the front end: every LLM call it makes flows through OmniRoute as a single custom provider, omp's model *roles* (`default`, `smol`, `slow`, `plan`, ...) map onto OmniRoute *combos*, and OmniRoute's admin surface (combos, quota, usage, fallback, health, sessions) is exposed inside omp via the `/omni` extension command and two agent tools.

Both upstream projects release roughly daily, so both are vendored as `git subtree --squash` trees under `vendor/`. All custom integration code lives under `integrations/`; `vendor/` is never edited — see `docs/upstream-sync.md`.

## Layout

- `vendor/omniroute` — OmniRoute upstream (built and run as the LLM gateway).
- `vendor/oh-my-pi` — oh-my-pi upstream (reference-only for seam auditing; integrations consume the **published** `@oh-my-pi/pi-coding-agent` npm package, never this tree).
- `integrations/omniroute-bridge` — server lifecycle, key provisioning, seeding, `models.yml`/`config.yml` writers.
- `integrations/omp-omniroute-extension` — the `/omni` omp extension (commands + agent tools).
- `integrations/launcher` — the `mywayai` CLI that wires everything together.
- `integrations/e2e` — headless end-to-end smoke test.
- `infra/` — docker-compose and a mock OpenAI-compatible provider for local/CI testing.

See `docs/quickstart.md` to get running and `docs/architecture.md` for how the pieces fit together.
- `docs/resilience-review.md` — fault analysis & hardening roadmap; `docs/adr/` — architecture decisions.

## License

This repository's own code (`integrations/`, `infra/`, `docs/`, root tooling) is MIT licensed — see `LICENSE`.

Both vendored upstreams are also MIT licensed; their original `LICENSE` files are preserved at `vendor/omniroute/LICENSE` and `vendor/oh-my-pi/LICENSE`.

- OmniRoute © its respective authors — https://github.com/diegosouzapw/OmniRoute
- oh-my-pi © its respective authors — https://github.com/can1357/oh-my-pi
