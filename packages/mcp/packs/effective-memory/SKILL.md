---
name: Effective Memory
description: The essential habits for an AI agent with memory — session bookends, learning triggers, verification, safety, and the operational discipline that turns raw recall into compounding intelligence. Pinned, always-injected.
version: "1.1.0"
creator: plur-ai
license: MIT
tags: [memory, learning, best-practices, session-management, feedback, safety, verification, discipline, time]
x-datacore:
  id: effective-memory
  injection_policy: on_match
  match_terms: [memory, learn, remember, session, feedback, engram, forget, correction, preference, recall, verification, safety, plur]
  domain: plur.best-practices
  engram_count: 12
  # Note: every engram in this pack carries `pinned: true` at the engram
  # level, which is the actual "always-inject" mechanism (introduced in
  # PLUR 0.9.4). Pack-level injection_policy: pinned is not a recognized
  # value in 0.9.4 — keep it on_match here so loaders that respect it
  # behave predictably; the per-engram pinned flags do the work.
---

# Effective Memory

Your agent has memory. These habits make it actually useful.

Without them, memory is a growing pile of assertions nobody retrieves. With them, memory compounds — each session builds on the last, corrections stick, and the agent gets measurably better over time.

This pack is **pinned** in PLUR 0.9.4+. Engrams here bypass keyword gating and are always eligible for injection at session start. They cover the meta-rules every agent needs regardless of domain: how to capture corrections, when to recall before answering, what "verified" means, how to stay safe with destructive actions, and why never to type a weekday from memory.

## Install

```bash
npx @plur-ai/cli@0.9.4 packs install effective-memory
```

(In 0.9.4+, `plur init` auto-installs this pack — manual install is rarely needed.)

## What's inside

12 engrams covering:

- **Capture** — call `plur_learn` immediately on corrections; detect correction-shaped phrases.
- **Recall** — `plur_recall_hybrid` before factual answers; don't confabulate.
- **Session lifecycle** — bookend with `plur_session_start` / `plur_session_end`; `plur_feedback` on injected engrams; `plur_timeline` for long-horizon agents.
- **Verification** — artifact-first; never bulk-mark as done from narrative text.
- **Safety** — irreversible actions need actual user confirmation and one-item dry-runs.
- **Discipline** — read before edit; don't ask "want to continue?" mid-task.
- **Time** — never type a day-of-week from memory.

## Why pinned

Pinned engrams (introduced in PLUR 0.9.4) bypass the keyword-relevance gate in `scoreEngram` and per-pack/per-domain caps in `fillTokenBudget`. They are always eligible for injection regardless of how the user's query keywords overlap with the engram statement. Use this for cross-cutting meta-rules only; pinning everything defeats the purpose.

## Versioning

| Version | Changes |
|---|---|
| 1.1.0 | Consolidated `plur-required` meta-rules into this pack. All engrams now `pinned: true`. Added verification, safety, discipline, and time-handling rules. Engram count 8 → 12. |
| 1.0.0 | Initial pack — 8 engrams covering session bookends, learning triggers, and feedback loops. |
