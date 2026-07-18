# Architecture

`@plur-ai/claw` is the OpenClaw plugin that gives every agent in the
gateway persistent memory — automatically, with no per-agent code
changes. It's a `ContextEngine` plugin: OpenClaw calls into it on every
session lifecycle event.

For the user-facing intro see [README.md](README.md). For the engine see
[`packages/core/ARCHITECTURE.md`](../core/ARCHITECTURE.md). For the
sibling MCP adapter see [`packages/mcp/ARCHITECTURE.md`](../mcp/ARCHITECTURE.md).

## The shape, in one paragraph

OpenClaw's `ContextEngine` protocol exposes lifecycle hooks: `assemble`
(called before each prompt build to inject context), `ingest` (called
per message for real-time correction detection), `compact` (called on
context compaction to extract learnings), and `afterTurn` (called after
every assistant response for batch learning + episode capture). Claw
implements that interface via `PlurContextEngine`, registered with
`api.registerContextEngine()`. It also installs two event hooks alongside
— `before_prompt_build` and `agent_end` — for runtimes that use the event
bus rather than the ContextEngine protocol. There is no UI, no MCP
transport, no user interaction — the entire memory layer is invisible.

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

OpenClaw's `ContextEngine` interface (from `src/types.ts`):

```ts
interface ContextEngine {
  readonly info: ContextEngineInfo        // { id, name, version, ownsCompaction }
  bootstrap?(params): Promise<BootstrapResult>   // optional: session init / scope setup
  ingest(params): Promise<IngestResult>          // required: per-message processing
  ingestBatch?(params): Promise<...>             // optional: batch ingest
  afterTurn?(params): Promise<void>              // optional: post-turn learning + capture
  assemble(params): Promise<AssembleResult>      // required: inject context before prompt build
  compact(params): Promise<CompactResult>        // required: extract learnings on compaction
  prepareSubagentSpawn?(params): Promise<...>    // optional: propagate scope to child session
  onSubagentEnded?(params): Promise<void>        // optional: clean up child session state
  dispose?(): Promise<void>                      // optional: clean up all session state
}
```

`PlurContextEngine` in `context-engine.ts` implements all required methods
plus the optional ones:

| Method | What it does |
|---|---|
| `info` | Returns `{ id: 'plur-claw', name: 'PLUR Memory Engine', version, ownsCompaction: false }` |
| `bootstrap` | Records session key for scope propagation to subagents |
| `ingest` | Real-time correction detection per message — runs `learner.ts`; fires `plur.learnRouted()` async (fire-and-forget) when confidence ≥ 0.7 |
| `assemble` | Injects relevant engrams before each prompt build via `plur.injectHybrid()` (BM25 + embeddings fallback to BM25-only) → `assembler.ts` formats the result |
| `compact` | Extracts learnings from accumulated messages before context is dropped |
| `afterTurn` | Primary learning pass: LLM self-report (🧠 I learned: section) + regex fallback; also captures episode summary |
| `prepareSubagentSpawn` | Inherits parent scope for the child session |
| `onSubagentEnded` | Cleans up child session scope and message state |
| `dispose` | Clears all in-memory session maps |

Learning and capture calls are fire-and-forget (`void promise.catch(...)`) —
`ingest` and `afterTurn` return fast; slow remote stores don't stall the agent turn.

### Parallel event hooks (legacy / redundancy path)

The plugin also registers two event hooks via `api.on()` alongside the
ContextEngine. These provide coverage for runtimes that use the event
bus rather than the ContextEngine protocol:

| Event | What it does |
|---|---|
| `before_prompt_build` | Injects engrams via `plur.inject()` (BM25 only — fast path) |
| `agent_end` | Captures episode summary from the last assistant message |

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
