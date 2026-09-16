# When a hook times out and no memory is injected

Symptom: the agent starts without memory, or the harness reports a hook timeout.
Reported against Codex; the reasoning applies to every synchronous harness.

## Why these hooks are synchronous, and therefore bounded

Claude Code's `hook-inject` is **async with a 90s timeout**, so it can absorb a
slow first recall. That trade does not transfer to Codex or Antigravity: an
async hook's `additionalContext` is delivered at the harness's "next safe point",
which is **not the turn that triggered it** — and for a `codex exec` one-shot,
never. So those hooks are synchronous, and a synchronous hook has a hard budget.

| Harness | Hook | Budget |
|---|---|---|
| Codex | `SessionStart`, `UserPromptSubmit` | 25s |
| Antigravity | pre-invocation | 20s |
| Cursor | `sessionStart` | 10s |
| Claude Code | `UserPromptSubmit` | 90s (async) |

Codex's own default is 600s. PLUR's are deliberately tight so a wedged hook
cannot hang a turn.

## What actually consumes the budget

A synchronous injection runs hybrid search first and falls back to BM25 on a
soft deadline (`injectWithFallback`):

1. **Hybrid deadline** — `PLUR_HOOK_HYBRID_DEADLINE_MS`, default **8s**.
2. **BM25 fallback** — runs *after* the deadline is missed. Sub-second on a few
   thousand engrams; longer on a very large store.
3. **Remote recall** (PLUR Enterprise) — `PLUR_REMOTE_RECALL_TIMEOUT_MS`,
   default **2s**, and it runs *before* the local pipeline, so its real cost is
   `max(0, remote − local)` rather than a straight addition.

The expensive item is not in that list: **loading the BGE embedder takes ~20s
cold** once a store passes a few thousand engrams. The 8s deadline exists to
abandon it — but the wait still happened, so the worst case is
`8s + BM25`, not `8s`.

## Two failures that look identical and want opposite fixes

**A. The deadline was missed, BM25 served the turn.** You will see on stderr:

```
[plur] hybrid injection exceeded 8000ms — falling back to BM25 for this turn.
```

Memory was injected, just keyword-only. If this is routine and you want
embeddings back, **raise** the deadline — and keep it below the harness budget
in the table above, or you convert this case into case B.

**B. The hook was killed at the harness budget, nothing was injected.** The
harness reports a timeout. Here you must **lower** the deadline, not raise it,
so the BM25 fallback starts sooner and the hook finishes inside its budget:

```sh
PLUR_HOOK_HYBRID_DEADLINE_MS=3000
```

If it still times out, the local embedder is the cost. Take it out of the hot
path entirely — recall stays keyword-only and `plur doctor` reports it:

```yaml
# ~/.plur/config.yaml
embeddings:
  enabled: false
```

The stderr message in case A recommends *raising* the deadline. That advice is
correct for A and wrong for B — read which one you have before acting on it.

## If the store is remote

A slow or unreachable PLUR Enterprise host cannot hang the hook — the dial is
bounded at 2s and fast-fails a host for 60s after a network-level failure. To
rule it out anyway:

```sh
PLUR_REMOTE_RECALL=0        # kill-switch, local only
PLUR_REMOTE_RECALL_TIMEOUT_MS=500
```

## Confirm before and after

```sh
plur doctor                 # embedder state, hook wiring, remote health
time plur inject 'test'     # BM25-only cost for your store
```

A store whose BM25 pass alone approaches the harness budget wants
`plur forget`/decay attention, not a larger timeout.
