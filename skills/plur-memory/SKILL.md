---
name: plur-memory
description: Persistent learning for AI agents. Open engram format. Your agent learns from corrections, remembers across sessions, and transfers knowledge across domains.
version: 0.21.5
metadata:
  hermes:
    tags: [memory, learning, knowledge, engrams]
    category: productivity
    requires_toolsets: []
---

# PLUR Memory

Persistent memory for AI agents. Corrections, preferences, and patterns are stored as **engrams** that strengthen with use and decay when irrelevant. The system gets smarter the longer you use it.

## When to Use

Use PLUR to recall relevant knowledge, learn durable corrections and close a memory session. Automatic injection depends on the installed editor adapter; an MCP connection alone does not install hooks.

## Discover the MCP tools

The default **lean** profile exposes core tools directly, including `plur_session_start`, `plur_session_end`, `plur_learn`, `plur_recall`, `plur_feedback`, `plur_forget`, `plur_status` and `plur_doctor`. Less-common operations are actions on `plur_admin`:

```json
{ "action": "help" }
```

Send that object to `plur_admin` to get current action names and argument schemas. For example, call `plur_admin` with `{ "action": "plur_inject", "args": { "task": "the current task" } }`. Destructive tools stay direct and cannot be dispatched through `plur_admin`. With `PLUR_TOOL_PROFILE=full`, operations are exposed by their own names instead.

Native integrations such as Hermes have their own tool surface. Use the names and schemas the current client exposes; the [Hermes skill](https://github.com/plur-ai/plur/blob/main/packages/hermes/plur_hermes/skills/plur-memory.SKILL.md) describes its native plugin.

## Memory Lifecycle

- Start an MCP memory session with `plur_session_start`; keep its session ID for later calls.
- With an editor adapter installed, relevant engrams are injected automatically.
- End the session with `plur_session_end` and a concise summary.
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

Adapters that support self-report learning can capture this format. MCP alone does not harvest response text; use `plur_learn` for an explicit save, and check its result.

## The Memory Line

End every reply with one short line: `Memory — recalled N · used: ENG-…, ENG-… · written: ENG-…` (recalled as a count; used and written as ids only, no statements), or `Memory — none`. Only count/list ids you actually saw this turn; never invent an id. Give details only if the user asks.

## Getting Started

On first install, PLUR has zero engrams — injection returns empty. This is expected.

Your first 5 sessions are the bootstrap period. Actively learn:
- Call `plur_learn` for every correction the user makes
- Call `plur_learn` for stated preferences ("always use X", "never do Y")
- Call `plur_learn` for discovered patterns and conventions

Recall becomes useful as relevant knowledge accumulates; there is no fixed engram-count threshold. For a pack, call `plur_admin` with `{ "action": "plur_packs_preview", "args": { "source": "/path/to/pack" } }`, review the contents, then install with action `plur_packs_install` and the same `source`. Use a directory or HTTPS archive URL, not a bare pack name.

## Meta-Engram Extraction

In MCP, `plur_extract_meta` runs the extraction pipeline using a configured LLM endpoint. In the lean profile, discover its schema through `plur_admin` help, then dispatch `{ "action": "plur_extract_meta", "args": { ... } }` with the required endpoint and API-key arguments. `dry_run: true` previews without saving. This operation can send selected memory to that endpoint; use it only for an authorized destination and task. It is not the native Hermes conversational pipeline.

Read existing results through the `plur_meta_engrams` admin action. Meta-engrams describe principles that transfer across domains.

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

Current MCP near-duplicate entries include the neighbour's statement preview. Read that text before deciding. For more context, dispatch `plur_similarity_search` through `plur_admin` with `{ "query": "the statement you just wrote" }`; it returns matching statements and scopes. Inspect the live schema if your client runs an older version.

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
plur_forget({ "id": "<new-id>" })
plur_learn({ "statement": "<statement>", "supersedes": ["<original-id>"] })
```

**Do not try to attach `supersedes` by re-learning the same statement.** That path hits exact content-hash dedup, which increments `write_count` and appends a source — it never writes `relations`. The edge is applied only when a *new* engram is created. So re-learning silently does nothing, and if you then forget the original you are left with a superseded fact archived and no record of what replaced it: worse than leaving it alone.

Retiring first is what makes the re-learn work — retired engrams are excluded from hash dedup (#107), so the second call creates a fresh engram and the edge lands on it.

If the two statements are genuinely distinct, the write stands and there is nothing to do.
