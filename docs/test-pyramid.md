# PLUR test pyramid

This document records the test architecture for plur-ai/plur, closing the
documentation gap left by issue #92 (CI integration for remote store test
levels). The original #92 spec assumed Docker-based integration tests; we
shipped a simpler-and-stronger approach using in-process stub servers.

## The four levels (from issue #78)

| Level | What | Where | Runs in CI? |
|-------|------|-------|-------------|
| 1. Unit | Pure functions, mocked dependencies | `packages/*/test/**/*.test.ts` (excluding `*-integration` / `*-smoke` / `*-live`) | Yes — every push + PR |
| 2. Integration | Real `RemoteStore` against an in-process HTTP stub | `packages/core/test/remote-integration.test.ts` (uses `helpers/stub-server.ts`) | Yes — included in `pnpm test` |
| 3. MCP E2E | Spawn real MCP client/server, route through stub | `packages/mcp/test/e2e-remote.test.ts`, `e2e.test.ts` | Yes — included in `pnpm test` |
| 4. Production smoke | Live HTTP roundtrip against `plur.datafund.io` | `packages/core/test/remote-smoke.test.ts` | **No** — opt-in via `pnpm test:smoke` + env vars; runs in `.github/workflows/smoke.yml` on manual trigger |

## Why stub server instead of Docker (deviation from #92 spec)

The original #92 plan called for a `plur-ai/enterprise-server:test` Docker
image hosted as a GitHub Actions service container. We use an in-process
Node HTTP stub instead (`packages/core/test/helpers/stub-server.ts`):

| Concern | Docker approach | Stub approach |
|---------|-----------------|---------------|
| Setup time | ~10s container pull + start per job | ~0ms (in-process) |
| Test determinism | Shared state across tests in same container | Per-test reset, isolated |
| Maintenance | Image needs publishing + versioning lockstep with server | Single TypeScript file |
| Coverage | Real wire protocol — but stub matches it 1:1 anyway | Real wire protocol via real `fetch` over loopback |
| Failure modes covered | Same as stub | Same as Docker |
| What stub misses | — | Server-side bugs (DB migration, auth, multitenancy) — but those belong in the enterprise repo's own tests, not ours |

The stub mirrors the enterprise server's REST contract for `/api/v1/engrams`
(GET, POST, DELETE, PATCH, POST /feedback). If the enterprise server's
contract drifts, the smoke tests (Level 4, run against the live server)
catch it.

## Running tests

```bash
# Levels 1 + 2 + 3 (no network, fast):
pnpm test                    # vitest run at root, ~10s

# Level 4 (network, opt-in):
PLUR_REMOTE_TEST_URL=https://plur.datafund.io \
PLUR_REMOTE_TEST_TOKEN=plur_sk_... \
PLUR_REMOTE_TEST_SCOPE=group:plur/test/smoke \
pnpm test:smoke

# Single integration suite:
pnpm test:integration
```

## CI workflows

- **`ci.yml`** — Levels 1-3 on every push and PR. Matrix: Node 20, Node 22.
- **`smoke.yml`** — Level 4 (production smoke). Triggers:
  - `workflow_dispatch` (manual)
  - `workflow_call` — meant to be invoked from a publish workflow after `npm publish` succeeds

The smoke workflow needs the `PLUR_REMOTE_TEST_TOKEN` repository secret set to a valid scoped token for `group:plur/test/smoke` on `plur.datafund.io`.

## Closes

- #78 epic (4 of 5 sub-issues closed; this doc + the smoke workflow close the remainder of #92)
- #92 (CI integration) — deviation from original spec documented above
