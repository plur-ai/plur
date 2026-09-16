# `@plur-ai/opencode` — native opencode plugin

**Status:** revision 1 — contract verified against a live binary
**Date:** 2026-09-15
**Owner:** Gregor
**Epic:** child of [#1034 — Extract a HarnessAdapter interface](https://github.com/plur-ai/plur/issues/1034) (E-15, milestone M2)
**Probe:** `scripts/probes/opencode-plugin-probe.mjs`

## Why opencode

opencode is a TypeScript/Bun agent harness whose plugins are **in-process ES
modules**. Core is TypeScript. That makes this the cheapest adapter PLUR can
build: no subprocess bridge (`plur-hermes`), no JSON hook shim
(`cli/src/codex-hooks.ts`, `cursor-hooks.ts`, `antigravity-hooks.ts`). It is
structurally the same integration as `@plur-ai/claw` — an in-process TS plugin
with lifecycle hooks — which is what makes it the right *second* example to
extract #1034's interface from. One example is not an interface.

## What was verified, and how

Everything below was measured against **opencode 1.18.30** /
`@opencode-ai/plugin@1.18.30` on 2026-09-15, not read from documentation. The
probe ran in an isolated `OPENCODE_CONFIG_DIR` so it could not touch the real
config.

The acceptance instrument was a marker-echo test: inject
`MARKER-<PATH>-7Q4X` down each candidate path, then ask the model to echo every
`MARKER-` token it can see. A `MARKER-CONTROL-7Q4X` was also minted, but never
injected anywhere and never shown to the model — so it was **not** echoed, and
that non-echo is the default expectation, not a discriminating result. What it
rules out is gross pattern-completion of the marker family (the model
inventing a plausible `MARKER-` token it never saw, having just seen two that
fit the pattern), not hallucination in general. A real per-path negative
control — the same path, injection switched off, model asked for markers,
answer `NONE` — was not run here; see `scripts/probes/README.md`.

| Capability | Hook | Verified result |
|---|---|---|
| Inject into user message | `chat.message` | Reached the model. **Accretes** — see below |
| Inject into system prompt | `experimental.chat.system.transform` | Reached the model. **Does not accrete** |
| Read assistant output | `event` → `message.part.updated` | Assistant text readable per part |
| Turn boundary | `event` → `session.idle` | Fires at end of turn (**twice** — must debounce) |
| Session start | `event` → `session.created` | Fires with full session info |
| Native tools | `tool: { … }` | Model called it and reported its return value |
| Teardown | `dispose` | Fires at process end |
| Compaction | `experimental.session.compacting` | **Not exercised** — needs a full context window |
| Permission gate | `permission.ask` | **Not exercised** |

Plugin context is `{ project, client, $, directory, worktree }`.

### The load-bearing measurement: accretion

`chat.message` pushes a `Part` onto the user message, and that part is
**persisted into session history**. A deterministic meter
(`experimental.chat.messages.transform`, which receives the exact message array
sent to the model) counted PLUR blocks across a three-turn session:

| Turn | `chat.message` injection on | `system.transform` only |
|---|---|---|
| 1 | 1 block in history | 0 blocks in history |
| 2 | 2 blocks in history | 0 blocks in history |
| 3 | 3 blocks in history | 0 blocks in history |

The `chat.message` column is the headline result and is soundly established
by this meter: injection there grows the transcript linearly and permanently,
and every block after the first is *stale* memory — recalled against an older
turn's query.

The `system.transform only` column is weaker than it reads. That arm was run
with `chat.message` injection disabled (`PLUR_PROBE_NO_PART`), so nothing ever
pushes a `Part` onto any message in the first place — a message-array meter
reading `0` there is close to tautological. It establishes only that
system-array content does not get copied into message history; it says
nothing about whether the `system[]` array itself grows turn over turn, which
is the actual claim this section needs. That claim rests on a different,
correctly-targeted observation: the probe logged the `system[]` array's length
going `1->2` on all three model calls of a tool-calling turn, and never
`2->3`. That is the evidence that `system.transform` receives a freshly-built
array on every request rather than one that accumulates — not the `0, 0, 0`
column above.

This reproduces the conclusion the `@plur-ai/dsh` design reached in its
revision 2 (`docs/specs/2026-08-14-dsh-plugin-design.md` §1): tail injection
accretes; a re-rendered system-prompt section does not. Two independent
harnesses, same answer. **This is the house pattern, and it should be stated as
one in #1034.**

### Cadence

The two hooks fire at different rates, and that difference is the design:

- `chat.message` — **once per user turn.** Correct cadence for running recall.
- `experimental.chat.system.transform` — **once per model request**, which means
  three times in a single tool-calling turn. Far too often to run recall.

## Architecture

```
chat.message            →  run recall, store rendered block in a per-session cache
                           (does NOT inject — injecting here accretes)
system.transform        →  render the cached block into system[]  (O(1), no recall)
event/message.part.*    →  accumulate assistant text for the turn
event/session.idle      →  debounce → learner → plur.learnRouted()  (fire-and-forget)
session.compacting      →  learn before context is dropped
dispose                 →  clear session state
```

Recall runs once per turn; the system prompt is re-rendered for free on every
request inside that turn. Cost is identical to claw's `assemble`, with none of
the accretion.

### Failure posture

Both primary hooks carry the `experimental.` prefix and the package published
a new version the day before this probe. The adapter must therefore:

- **Detect, not assume.** If `system.transform` has not fired by the end of the
  first turn, fall back to `chat.message` injection and log a one-line warning.
  A memory layer that silently injects nothing is the documented default
  failure mode for PLUR plugin releases (`plur-hermes` 0.19.2 → 0.19.4 failed
  inertly at three successive layers).
- **Never throw into the host.** Every hook wrapped; a PLUR failure degrades to
  no-memory, never to a broken agent turn.
- **Never block the turn.** Learning and capture are fire-and-forget, as in claw.

## Scope

**In:** automatic injection, automatic learning, learn-before-compaction,
session scope, `plur init --opencode`.

**Out — native `tool` definitions.** They work (verified), but PLUR already has
a maintained tool surface in `@plur-ai/mcp`, and opencode loads MCP servers from
config. Adding a sixth hand-maintained tool surface would put it under the
feature-parity rule (core → MCP → CLI → hermes bridge → hermes tool defs) for
no user-visible gain. `plur init --opencode` therefore writes **both** the
`plugin` entry (automatic layer) and the `mcp` entry (explicit tools), which is
the three-layer strategy the product already commits to: context files +
hooks/plugins + MCP tools.

## Known gotchas

1. **Part schema is validated.** An injected part needs `id` matching `prt_*`
   and a string `messageID`, or opencode rejects the whole message with
   `invalid user part before save`. `input.messageID` **is `undefined`** in
   `chat.message` — the id must come from `output.message.id`. This only
   matters for the fallback path, but it is a hard failure when wrong.
2. **`worktree` degenerates outside a git repo.** It was `/` in a non-git
   directory, with `projectID=global`. Scope resolution prefers a real
   `worktree` and falls back to `directory` — it must never trust the
   degenerate `"/"` value.
3. **`session.idle` fires more than once per turn.** Debounce, or the learner
   runs twice on the same transcript.

## Definition of done

A real opencode turn, against the published package, in which the model recites
a fact it was taught in an earlier session — plus the accretion meter reading
**0 blocks in history** after three turns. File presence, plugin load, and hook
registration are explicitly *not* evidence.
