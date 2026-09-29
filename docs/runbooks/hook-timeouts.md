# When a hook times out and no memory is injected

Symptom: the agent starts without memory, or the harness reports a hook timeout.
Reported against Codex; the reasoning applies to every synchronous harness.

## Why these hooks are synchronous, and therefore bounded

An async hook's `additionalContext` is delivered at the harness's "next safe
point", which is **not the turn that triggered it**: a first reply that uses no
tools gets no memory, and a one-shot (`codex exec`, `claude -p`) never does. So
every injection hook is synchronous, and a synchronous hook has a hard budget.
Claude Code's `hook-inject` was async with a 90s timeout until #1313.

| Harness | Hook | Budget |
|---|---|---|
| Codex | `SessionStart`, `UserPromptSubmit` | 25s |
| Antigravity | pre-invocation | 20s |
| Cursor | `sessionStart` | 10s |
| Claude Code | `UserPromptSubmit`, `SessionStart` (matcher `compact`) | 20s; the hook exits itself at 15s (`PLUR_HOOK_CEILING_MS`) |
| All four | end-of-turn auto-rate (`hook-auto-rate`, #1310) | 10s (sync), self-capped at 9s |

Codex's own default is 600s. PLUR's are deliberately tight so a wedged hook
cannot hang a turn.

The auto-rate hook opens the store only when the session injected something
that has not been rated yet; otherwise its cost is a Node start and one small
file read. When it does open the store, it reads the pending ids and writes one
feedback signal per verdict. It dials a remote store only to rate one of its
engrams. That costs at most one bounded `/me` call per process, to check for the
`feedback.source` capability, plus the feedback call if the server has it. `PLUR_AUTO_RATE=0` turns
it off, and `PLUR_AUTO_RATE_CEILING_MS` moves its self-cap.

In Claude Code only the first prompt of a session and the rehydrate after
compaction do the full injection. Later prompts check the session marker and
exit: 68 to 101ms on a 10,000-engram store, against 34ms for a bare
`node -e 0`. Re-run `plur init` to move an existing async registration to sync.

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

## Outbox flush at session end (#1269)

Session-end and stop hooks also retry queued team writes (the outbox). They
are bounded so they cannot cost the hook its budget:

| Harness | Hook | Hook timeout | Flush budget |
|---|---|---|---|
| Claude Code | `SessionEnd` | 5s | 2.5s |
| Codex | `SessionEnd` | 3s (clamped by Codex) | 1.2s |
| Cursor | `stop` | 3s | 1.2s |

With nothing queued the flush is skipped after one file read. Cursor's `stop`
fires on every turn, so it retries at most once every five minutes. When the budget
runs out the in-flight push is cut, nothing further starts, and every
undelivered write stays queued. A cut is our time running out, not a failure
of the remote, so it does not count toward the host's circuit breaker. The
budget starts after the local store load. A push cut mid-flight is recorded
and checked against the server before it is posted again, so a slow server
does not gain a copy per retry (`docs/remote-store-contract.md`).

```sh
PLUR_HOOK_OUTBOX_FLUSH=0        # turn the hook flush off
PLUR_HOOK_OUTBOX_FLUSH_MS=800   # smaller budget; keep it well below the hook timeout
```

`plur sync` and `plur outbox --flush` flush without a budget (each request is
still bounded at 30s).
