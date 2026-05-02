---
name: Effective Memory
description: Make your AI agent remember what matters. Session boundaries, learning triggers, feedback loops, and anti-patterns — the habits that turn raw memory into compounding intelligence.
version: "1.0.0"
creator: plur-ai
license: MIT
tags: [memory, learning, best-practices, session-management, feedback]
x-datacore:
  id: effective-memory
  injection_policy: on_match
  match_terms: [memory, learn, remember, session, feedback, engram, forget, correction, preference]
  domain: plur.best-practices
  engram_count: 8
---

# Effective Memory

Your agent has memory. These habits make it actually useful.

Without them, memory is a growing pile of assertions nobody retrieves. With them, memory compounds — each session builds on the last, corrections stick, and the agent gets measurably better over time.

## Install

```bash
npx @plur-ai/cli@0.9.1 packs install effective-memory
```

> `@0.9.1` is pinned because `@plur-ai/cli@latest` (0.9.2) is bricked — see [plur-ai/plur#59](https://github.com/plur-ai/plur/issues/59). The pin can be removed once 0.9.3 ships.
