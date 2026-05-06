# Architecture

`@plur-ai/claw` is the OpenClaw plugin that gives every agent in the
gateway persistent memory — automatically, with no per-agent code
changes. It's a `ContextEngine` plugin: OpenClaw calls into it on every
session lifecycle event.

For the user-facing intro see [README.md](README.md). For the engine see
[`packages/core/ARCHITECTURE.md`](../core/ARCHITECTURE.md). For the
sibling MCP adapter see [`packages/mcp/ARCHITECTURE.md`](../mcp/ARCHITECTURE.md).

## The shape, in one paragraph

OpenClaw exposes a `ContextEngine` lifecycle: `onSessionStart`, `onTurn`,
`onSessionEnd`. Claw implements that interface, hooks each event into a
`Plur` instance from `@plur-ai/core`. On session start it injects
relevant engrams into the system prompt. On every assistant turn it
runs the learner over the conversation looking for corrections /
preferences / decisions. On session end it captures the episode and
runs decay. There is no UI, no MCP transport, no user interaction — the
entire memory layer is invisible.

## Top-level layout

```
src/
├── index.ts               # Plugin export — what OpenClaw imports
├── context-engine.ts      # ContextEngine impl — the lifecycle hooks
├── assembler.ts           # Build the system-prompt engram block
├── system-prompt.ts       # Format engrams into prompt-shaped text
├── learner.ts             # Auto-extract learnings from a turn
├── setup.ts               # CLI: enable plugin in OpenClaw config
├── cli.ts                 # CLI dispatch (setup, doctor)
├── telemetry.ts           # Per-event observability
├── telemetry-counters.ts  # In-memory counters surfaced in /status
└── types.ts               # Shared types
```

`openclaw.plugin.json` (at package root) declares the plugin name,
slot, version — OpenClaw reads this when discovering plugins.

## ContextEngine integration

OpenClaw's `ContextEngine` interface (simplified):

```ts
interface ContextEngine {
  info(): { name, version, slot }
  onSessionStart(session): Promise<{ inject?: string }>
  onTurn(session, turn): Promise<{ inject?: string, capture?: any }>
  onSessionEnd(session): Promise<void>
}
```

Claw's implementation in `context-engine.ts`:

| Hook | What it does |
|---|---|
| `info()` | Returns `{ name: 'plur-claw', version, slot: 'memory' }` |
| `onSessionStart` | Calls `plur.inject(task)` → builds system-prompt block via `assembler.ts` → returns `{ inject }` |
| `onTurn` | Runs `learner.ts` over the user+assistant turn → if corrections detected, calls `plur.learn()` async (background) → optionally captures the turn as an episode |
| `onSessionEnd` | Calls `plur.capture(summary)` → `plur.batchDecay()` if it's been a while |

All operations are awaited from OpenClaw's perspective but the actual
LLM-blocking work (learn, capture) is queued — `onTurn` returns fast.

## Assembler (`assembler.ts`)

Given an `inject` result from `Plur`, build the formatted system-prompt
text block:

```
## DIRECTIVES

[ENG-2026-...] High-confidence engram statement.
  Domain: ... | Confidence: 0.85 | Last verified: ...

## ALSO CONSIDER

[ENG-2026-...] Lower-confidence statement | [ENG-...] Another
```

The format is opinionated: directives are listed, "also consider" is a
single-line tail. Identical format to `@plur-ai/mcp`'s session-start
output — agents see the same shape regardless of host.

## Learner (`learner.ts`)

The big challenge: automatically detect when a user corrects the agent,
states a preference, or shares a fact worth remembering — without
spamming engrams from every casual message.

Heuristics, in order:

1. **Length filter**: skip messages shorter than ~10 chars or longer
   than ~500 (later relaxed for chat content per ENG-2026-0320-011)
2. **Pattern match**: regex for "no, X" / "always X" / "never X" /
   "use X not Y" / "the right way is X" — these are high-precision
   correction signals
3. **Sentence-level scan**: split multi-paragraph turns and run pattern
   match per sentence (not per message — a single long correction in a
   long message is what we want to catch)
4. **Polarity detection**: "do X" + later "don't X" surfaces as
   contradiction, not silently overwriting

When a candidate fires, it goes to `plur.learn()` which itself runs
quality / dedup / conflict gates before persisting.

The learner is intentionally conservative — false positives are worse
than false negatives. If a user corrects the agent and the learner
misses it, the next correction probably catches it. If the learner
fires on a casual remark, the engram is wrong forever.

## Setup flow (`setup.ts`)

`npx @plur-ai/claw setup` does:

1. Read `~/.openclaw/openclaw.json`
2. Set `plugins.entries['plur-claw'].enabled = true`
3. Set `plugins.slots.memory = 'plur-claw'` (or merge if user has a
   custom resolver)
4. Optionally add to community allowlist if user opted in
5. Print restart instructions

Pure config edit — no MCP registration, no hook installation. OpenClaw
already exposes plugins to its agents.

## Telemetry (`telemetry.ts`, `telemetry-counters.ts`)

Per-event counters: `injects_attempted`, `engrams_injected`,
`learnings_captured`, `errors_swallowed`, etc. Exposed via the OpenClaw
status surface. Pure local — never sent off-machine.

When debugging "why didn't my agent learn this", check the counters
first; they'll show whether the learner ran at all.

## Boundary with `@plur-ai/core`

Claw imports `Plur` from `@plur-ai/core`'s built `dist`, not source —
this is set up at the monorepo level. Important consequence:

> After changing core, **rebuild core before running claw tests**:
> `pnpm --filter @plur-ai/core build`

Otherwise claw's tests run against stale dist and can pass with an old
implementation. The monorepo CLAUDE.md restates this.

Claw never reaches into core's internals — only the `Plur` class
methods. If a needed primitive isn't exposed, add it to core, don't
work around it here.

## What's NOT here

- **No MCP transport** — that's `@plur-ai/mcp`. Claw is a different
  integration mechanism (plugin slot, not MCP tool).
- **No engine code** — every storage / search / decay decision is core
- **No user-facing CLI beyond setup/doctor** — Claw is invisible at
  runtime by design
- **No multi-user awareness** — like `@plur-ai/mcp`, this is single-user
  local memory. PLUR Enterprise handles teams.

## See also

- [README.md](README.md) — public-facing intro
- [`packages/core/ARCHITECTURE.md`](../core/ARCHITECTURE.md) — engine
- [`packages/mcp/ARCHITECTURE.md`](../mcp/ARCHITECTURE.md) — sibling adapter
- [OpenClaw docs](https://openclaw.com)
