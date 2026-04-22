---
name: plur-memory
description: Persistent learning for AI agents. Open engram format. Your agent learns from corrections, remembers across sessions, and transfers knowledge across domains.
version: 0.9.0
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
