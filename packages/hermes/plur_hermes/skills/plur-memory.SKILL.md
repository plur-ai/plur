---
name: plur-memory
description: Persistent learning for AI agents. Open engram format. Your agent learns from corrections, remembers across sessions, and transfers knowledge across domains.
version: 0.19.1
metadata:
  hermes:
    tags: [memory, learning, knowledge, engrams]
    category: productivity
    requires_toolsets: []
---

# PLUR Memory

Persistent memory for AI agents. Corrections, preferences, and patterns are stored as **engrams** that strengthen with use and decay when irrelevant. The system gets smarter the longer you use it.

## When to Use

Always. Memory is not a feature you toggle — it's a layer that runs continuously.

The plugin automatically injects relevant engrams into every conversation turn via the `pre_llm_call` hook. You don't need to call `plur_inject` manually unless you want full hybrid search (the automatic path uses fast BM25 search).

## Memory Lifecycle

- **Automatic injection** runs every turn — relevant engrams appear in your context as `<plur-memory>` blocks
- When you discover something worth remembering → call `plur_learn` with a clear statement
- When corrected by the user → call `plur_learn` immediately with the correction
- When an injected engram was helpful → call `plur_feedback` with signal "positive"
- When an injected engram was wrong or stale → call `plur_feedback` with signal "negative"
- When a memory is no longer true → call `plur_forget` with the engram ID

## The Learning Protocol

End your responses with a learning section when you discover reusable insights:

```
---
🧠 I learned:
- Insight one (min 10 characters)
- Insight two
```

The plugin auto-captures these — no manual `plur_learn` call needed. This is a convenience fallback; calling `plur_learn` directly is preferred for important learnings.

## Getting Started

On first install, PLUR has zero engrams — injection returns empty. This is expected.

Your first 5 sessions are the bootstrap period. Actively learn:
- Call `plur_learn` for every correction the user makes
- Call `plur_learn` for stated preferences ("always use X", "never do Y")
- Call `plur_learn` for discovered patterns and conventions

After ~20 engrams, injection starts returning useful context automatically. To accelerate, install a community pack via `plur_packs_install`.

## Meta-Engram Extraction

Periodically run `plur_extract_meta` to distill cross-domain principles from your engrams.

The extraction is a multi-turn conversation:
1. Call `plur_extract_meta` — returns analysis prompts with `"status": "prompts_ready"`
2. Process each prompt using your reasoning
3. Call `plur_meta_submit_analysis` with your responses as `{"responses": [...]}`
4. Repeat steps 2-3 until you receive `{"status": "complete"}`

If you call `plur_meta_submit_analysis` with no active pipeline, you'll get `{"status": "no_active_pipeline"}` — call `plur_extract_meta` first.

Meta-engrams are the highest-value knowledge: principles that transfer across domains.

## What NOT to Learn

- Trivial facts ("the user said hello")
- Things already in the codebase (file paths, function names — those change)
- Session-specific state ("we're working on X right now")
- Anything you're not confident about

## What to Learn

- Corrections: "The API returns snake_case, not camelCase"
- Preferences: "User prefers TypeScript over JavaScript"
- Patterns: "This codebase uses repository pattern for data access"
- Decisions: "We chose PostgreSQL for ACID compliance"
- Conventions: "Always run lint before committing"

## Near-Duplicate Protocol

A `plur_learn` response may carry a `dedup` field reporting engrams close to what you just wrote. Convention, not a gate — the engine will not stop you, and nothing else will notice a reworded restatement.

### 1. Read `dedup.mode` first

- `cosine` — similarity ran locally, and `near_duplicates` lists what it found.
- `hash-only` — **only** the exact-hash check ran: no candidates, no embedder, or dedup disabled. This means "not identical", **not** "not a duplicate".
- `llm` — semantic classification. `plur_learn_batch` only; it never appears on a single `plur_learn`.

**A missing `dedup` field is ambiguous and you cannot resolve it from the response.** It is omitted both when similarity ran and found nothing close, and when similarity never ran at all. Absence is therefore not evidence that your write is unique.

### 2. Resolve the ids to statements

Entries are `{ id, score }` — **there is no statement text in the payload**, and no fetch-by-id tool. To see what you nearly duplicated, run `plur_similarity_search` with the same statement you just wrote: it uses the same cosine mechanism, so its `engram_id` values line up with `near_duplicates`, and it returns `statement` and `scope` alongside them.

Skipping this step means deciding on a number alone, which the next point explains is not enough.

### 3. Judge on content — `score` orders the list, it does not decide

**Do not use a similarity threshold as a decision boundary.** The measurements behind #878 are the reason:

| Pair | Score |
|---|---|
| the real #854 duplicate, as actually written | 0.8339 |
| "always rebase" vs "never rebase" — opposite meanings | 0.8826 |

A genuine duplicate scored *below* two statements that contradict each other. Any fixed cut-off puts the founding case on the wrong side. Treat `score` as the order to inspect in, then read the statements and decide whether they assert the same fact.

For reference, the engine records a `dedup_near_duplicate` history event above `NEAR_DUPLICATE_OBSERVATION_FLOOR = 0.75` — that is what it considers notable enough to log, not a threshold for you to act on.

### 4. If it is the same fact, use one recipe

Whether you are restating or correcting, the sequence is the same:

```
plur_forget <new-id>
plur_learn "<statement>" supersedes: [<original-id>]
```

**Do not try to attach `supersedes` by re-learning the same statement.** That path hits exact content-hash dedup, which increments `write_count` and appends a source — it never writes `relations`. The edge is applied only when a *new* engram is created. So re-learning silently does nothing, and if you then forget the original you are left with a superseded fact archived and no record of what replaced it: worse than leaving it alone.

Retiring first is what makes the re-learn work — retired engrams are excluded from hash dedup (#107), so the second call creates a fresh engram and the edge lands on it.

If the two statements are genuinely distinct, the write stands and there is nothing to do.
