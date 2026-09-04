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
  # The engrams below still carry `pinned: true`, but INSTALL STRIPS IT.
  # `sanitizePackEngrams` removes `pinned` and downgrades `commitment: locked`
  # from every pack, this one included, because a pack is an archive from a
  # stranger and its author does not get to decide what is always in front of
  # the recipient's model. The flags are left in place so the intent is
  # legible and so the behaviour returns if the host ever grows a way to
  # grant it deliberately. `injection_policy: on_match` is what actually
  # governs this pack. See plur-ai/plur#1019.
---

# Effective Memory

Your agent has memory. These habits make it actually useful.

Without them, memory is a growing pile of assertions nobody retrieves. With them, memory compounds — each session builds on the last, corrections stick, and the agent gets measurably better over time.

These engrams cover the meta-rules every agent needs regardless of domain: how to capture corrections, when to recall before answering, what "verified" means, how to stay safe with destructive actions, and why never to type a weekday from memory.

They were written to be **pinned** — always eligible for injection, bypassing keyword gating. That is no longer what happens. Install strips `pinned` from every pack, this one included, so these engrams are matched on keywords like any other (`injection_policy: on_match`, with the `match_terms` above). The stripping is right — a pack author should not be able to occupy a recipient's context unconditionally — but it means this pack's meta-rules only surface when a session's wording happens to touch them.

## Install

```bash
npx @plur-ai/cli@0.9.4 packs install effective-memory
```

(In 0.9.4+, `plur init` auto-installs this pack — manual install is rarely needed.)

## What's inside

12 engrams covering:

- **Capture** — call `plur_learn` immediately on corrections; detect correction-shaped phrases.
- **Recall** — `plur_recall` before factual answers; don't confabulate.
- **Session lifecycle** — bookend with `plur_session_start` / `plur_session_end`; `plur_feedback` on injected engrams; `plur_timeline` for long-horizon agents.
- **Verification** — artifact-first; never bulk-mark as done from narrative text.
- **Safety** — irreversible actions need actual user confirmation and one-item dry-runs.
- **Discipline** — read before edit; don't ask "want to continue?" mid-task.
- **Time** — never type a day-of-week from memory.

## Why these were written pinned, and what happens instead

Pinned engrams bypass the keyword-relevance gate in `scoreEngram` and the per-pack and per-domain caps in `fillTokenBudget`. Cross-cutting meta-rules are the case that justifies it: "call `plur_learn` when corrected" is relevant to every session and keyword-matches almost none of them.

**Install strips the flag**, so that is not the behaviour you get. `sanitizePackEngrams` removes `pinned` and downgrades `commitment: locked` from every installed pack, and it is right to — a pack is an archive from a stranger, and letting its author decide what is permanently in front of your model is a privilege no producer should take by shipping a YAML field.

The consequence is that this pack's rules are keyword-gated, which is a weaker guarantee than they were designed for. Whether a host should be able to grant always-inject to a pack it trusts deliberately — as opposed to a pack claiming it — is an open question, tracked in plur-ai/plur#1019.

## Versioning

| Version | Changes |
|---|---|
| 1.1.0 | Consolidated `plur-required` meta-rules into this pack. All engrams now `pinned: true`. Added verification, safety, discipline, and time-handling rules. Engram count 8 → 12. |
| 1.0.0 | Initial pack — 8 engrams covering session bookends, learning triggers, and feedback loops. |
