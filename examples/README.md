# PLUR examples

Runnable, copy-pasteable getting-started scripts for [`@plur-ai/core`](../packages/core).
Each is self-contained, writes to a throwaway temp store (never your real
`~/.plur`), and prints what it does.

## Prerequisites

From the repo root, once:

```bash
pnpm install
pnpm build      # examples import the built @plur-ai/core
```

## Run

```bash
pnpm --filter @plur-ai/examples ex:basic   # 01 — store & recall
pnpm --filter @plur-ai/examples ex:mcp     # 02 — MCP integration / inject
pnpm --filter @plur-ai/examples ex:scope   # 03 — multi-project scope filtering
pnpm --filter @plur-ai/examples all        # run all three
```

## What each shows

| File | What it demonstrates |
|------|----------------------|
| [`01-basic-store-recall.ts`](01-basic-store-recall.ts) | Store engrams, recall the most relevant (BM25, sync, zero-cost) |
| [`02-mcp-integration.ts`](02-mcp-integration.ts) | The `.mcp.json` config `npx @plur-ai/mcp init` writes, and the `plur_inject` operation an MCP client calls for you |
| [`03-scope-filtering.ts`](03-scope-filtering.ts) | One store, many projects — scope isolation with global facts always included |

## Notes

- The examples use the **synchronous, BM25** API (`recall`, `inject`) so they run
  instantly with no model download. For semantic search, swap in the async
  `recallHybrid` / `injectHybrid` — same arguments, plus local BGE embeddings.
- These run in CI on every PR (`.github/workflows/ci.yml`) so they can't silently
  rot against API changes.
