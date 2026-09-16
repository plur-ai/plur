# Architecture

`@plur-ai/opencode` is the [opencode](https://opencode.ai) plugin that gives
every agent session in the harness persistent memory — automatically, no tool
call required. opencode plugins are in-process ES modules with lifecycle
hooks; this package implements a small set of them.

For the user-facing intro see [README.md](README.md). For the engine see
[`packages/core/ARCHITECTURE.md`](../core/ARCHITECTURE.md). For the sibling
adapters see [`packages/claw/ARCHITECTURE.md`](../claw/ARCHITECTURE.md) (same
in-process-plugin shape) and [`packages/mcp/ARCHITECTURE.md`](../mcp/ARCHITECTURE.md).

## The shape, in one paragraph

opencode fires `chat.message` once per user turn and
`experimental.chat.system.transform` once per model request (up to three times
in a single tool-calling turn). This package splits recall and rendering
across exactly that boundary: `chat.message` runs recall and caches the
rendered memory block for the session; `system.transform` reads the cache and
pushes it into `system[]`, doing no recall of its own. That split is not
stylistic — it is the entire reason this package exists in this shape. See
[The accretion measurement](#the-accretion-measurement-read-this-before-changing-anything)
before touching either hook.

## Top-level layout

```
src/
├── index.ts        # Plugin export — the hook map opencode imports
├── block.ts         # BlockCache — one rendered memory block per session, overwrite-only
├── capability.ts     # RenderPath — detects whether system.transform is still firing
├── turn.ts          # TurnBuffer — accumulates assistant text per turn, one-shot take
├── learn.ts         # The two learning paths (self-report + user-correction)
├── scope.ts         # resolveScopeRoot — worktree vs directory
└── version.ts        # OPENCODE_PLUGIN_VERSION — the one place the plugin version is written
```

There is no `setup.ts` here — unlike `@plur-ai/claw`, this package does not
configure its own host. `plur init --opencode` (the config writer) lives in
`packages/cli/src/opencode-config.ts`, not here: opencode resolves the plugin
by fetching `@plur-ai/opencode` from npm at load time, so the CLI never needs
this package present to write a config file that merely names it. Coupling the
writer to this package would also tie two independent version tracks together
for no reason — see [RELEASING.md](../../RELEASING.md).

## Hook mapping

| Hook | Cadence (measured, opencode 1.18.30) | What it does |
|---|---|---|
| `chat.message` | Once per user turn | Runs `plur.injectHybrid()`, renders the result via `renderMemoryBlock()`, and caches it in `BlockCache` keyed by session. Injects **nothing** under normal operation — see below. Also records the user's message id (`TurnBuffer.markUserMessage`) and fires the user-correction learning path. |
| `experimental.chat.system.transform` | Once per model request (≤3× per turn) | Reads the cached block and pushes it into `output.system`. O(1) — no recall, no store access. Marks `RenderPath` as having rendered this turn. |
| `event` → `message.part.updated` | Per streamed text chunk | Appends the assistant's (and, until excluded, the user's own) text into `TurnBuffer`, keyed by part id with latest-wins semantics — see the class docstring for why both of those are load-bearing. |
| `event` → `session.idle` | Twice per turn (measured) | Marks the turn boundary for `RenderPath`, then takes the turn's buffered text (one-shot — the second fire in the same turn is a no-op) and runs the self-report learning path. |
| `event` → `session.deleted` | Once, on session deletion | Clears that session's cached block and turn buffer. |
| `experimental.session.compacting` | Before context is dropped | Pushes the cached block into `output.context` so memory survives the cut, and runs the turn's learning path on whatever hasn't been learned yet — never sets `output.prompt`, which would replace the host's own compaction prompt. |
| `dispose` | Process teardown | Clears `BlockCache`. |

Every hook body is wrapped in a `safe()` helper: a thrown error inside any hook
is caught and logged (`PLUR_DEBUG=1`), never propagated into the host. A
memory-layer failure degrades to no-memory, not to a broken agent turn.

## The accretion measurement — read this before changing anything

`chat.message` pushes a `Part` onto the user message, and opencode **persists
that part into session history**. Measured directly against opencode 1.18.30
with a deterministic meter (`experimental.chat.messages.transform`, which
receives the exact message array sent to the model) across a 3-turn session:

| Turn | Injecting via `chat.message` | Injecting via `system.transform` |
|---|---|---|
| 1 | 1 block in history | 0 blocks in history |
| 2 | 2 blocks in history | 0 blocks in history |
| 3 | 3 blocks in history | 0 blocks in history |

The first column is the soundly-measured half: injecting at `chat.message`
grows the transcript linearly and permanently, and every block after the
first is *stale* — rendered against an earlier turn's recall query, not the
current one.

The second column is a weaker instrument than the table implies. It was
measured with `chat.message` injection switched off, so no `Part` was ever
pushed onto any message to begin with — a message-history meter reading `0`
there is close to tautological. It shows only that `system[]` content isn't
copied into message history; it does not by itself show that `system[]`
stays flat across the three calls within one turn. That is established
separately: the probe logged the `system[]` array's length going `1->2` on
every one of the three model calls in a tool-calling turn, never `2->3`. A
freshly-built array every request — not the `0, 0, 0` column above — is what
proves `system.transform` receives a rebuilt array rather than an
accumulating one.

This reproduces the conclusion `@plur-ai/dsh`'s design reached independently
(`docs/specs/2026-08-14-dsh-plugin-design.md` §1) on a different harness: tail
injection into message history accretes; a re-rendered system-prompt section
does not. Two unrelated in-process plugin harnesses, same answer — this is the
house pattern for this integration shape, not a coincidence of opencode's API.

**This is why `chat.message` looks like it does almost nothing.** Its
docstring in `index.ts` says so explicitly, and `test/e2e.manual.mjs` asserts
the accretion count is `0` on every turn of a live 3-turn session — not merely
that the hooks return the right shape. If a future change moves injection back
into `chat.message` "to simplify," that test will fail, and the failure is the
point: it is what accretion looks like from the inside, five minutes before
someone notices the transcript is growing.

## The fallback path (`RenderPath`)

Both `chat.message` and `system.transform` carry opencode's `experimental.`
prefix, on a package that ships close to daily. `capability.ts`'s `RenderPath`
detects, rather than assumes, that `system.transform` is still firing: if a
full turn passes (`session.idle`) without a render having happened
(`markRendered()`), the detector latches permanently. Once latched,
`chat.message` starts pushing the cached block as a real `Part` — accepting
the accretion this file just spent two sections warning against, because a
working-but-accreting memory layer beats one that has silently gone dark. The
evaluation is lazy (`shouldFallback()` is what actually decides, on the next
read) and non-sticky in the other direction: a render happening once does not
clear a latch that already fired, and a *regression* that starts mid-session
(after earlier turns rendered fine) is still caught rather than masked by a
stale "it worked once" flag. See the class docstring in `capability.ts` for
the full reasoning and the ordering constraints that make it safe.

## Failure posture

- **Detect, not assume.** `RenderPath` above, rather than trusting that an
  `experimental.` hook keeps working across opencode releases.
- **Never throw into the host.** Every hook is wrapped in `safe()`.
- **Never block the turn.** Both learning paths (`learn.ts`) are
  fire-and-forget — `void promise.catch(...)` — so a slow or unreachable store
  never stalls a response the user is waiting on.
- **Never touch the host's own compaction prompt.** `experimental.session.compacting`
  only appends to `output.context`; it never assigns `output.prompt`.

## Learning (`learn.ts`)

Two independent paths, mirroring `@plur-ai/claw`'s `afterTurn`:

1. **Self-report** (`learnFromTurn`) — the assistant's own `🧠 I learned:`
   block, parsed by `extractSelfReportedLearnings` (shared with claw, lives in
   `@plur-ai/core`) from the turn's buffered assistant text. Runs on
   `session.idle` and again, if anything unlearned remains, on
   `experimental.session.compacting`.
2. **User correction** (`learnFromUserText`) — `extractLearnings` (also shared
   with claw) over the same user text `chat.message` already builds its recall
   query from, persisted at confidence ≥ 0.7. Runs on every `chat.message`.

Both call `plur.learnRouted()` with `scope`/`domain` from the project's
`.plur.yaml` when one is found (see [Scope](#scope) below), fire-and-forget.

## Scope

`resolveScopeRoot()` (`scope.ts`) picks the root the plugin scopes a session
by: opencode's `worktree` when it looks like a real path, else `directory`,
else `process.cwd()`. `worktree` is measured as `"/"` outside a git repository
(opencode 1.18.30) — using it unconditionally would scope every non-repo
session to the filesystem root.

That root is passed to `readProjectConfig()` — the same `.plur.yaml` walk
`@plur-ai/mcp` uses — and its `scope`/`domain`, if present, become the default
for recall and for both learning paths. It is also passed as `cwd` to the
`Plur` constructor, which drives store auto-discovery (adding a store when a
`.plur/engrams.yaml` already exists between the scope root and the git root)
— that alone does not create a per-project store or filter recall; `.plur.yaml`
is the mechanism that does.

## What's NOT here

- **No native `tool` definitions.** They work (verified against the real
  binary), but `@plur-ai/mcp` already ships a maintained `plur_*` tool surface
  that opencode can load as an MCP server, and a sixth hand-maintained tool
  surface would sit under the project's feature-parity rule for no user-visible
  gain. `plur init --opencode` writes both the `plugin` entry (this package,
  automatic) and an `mcp.plur` entry (`@plur-ai/mcp`, explicit) — the same
  three-layer strategy (context files + hooks/plugins + MCP tools) the product
  already commits to everywhere else.
- **No `permission.ask` handling.** Listed in the design spec as unexercised;
  not on the critical path for a memory layer.
- **No host config writer.** See [Top-level layout](#top-level-layout) above —
  that lives in `packages/cli`.
- **No engine code.** Every storage / search / decay decision is core.
- **No multi-user awareness.** Single-user local memory, like every other
  PLUR adapter. PLUR Enterprise handles teams.

## See also

- [README.md](README.md) — public-facing intro, install, the live acceptance gate
- [`docs/specs/2026-09-15-opencode-plugin-design.md`](../../docs/specs/2026-09-15-opencode-plugin-design.md) — the full verification record this file summarizes
- [`packages/core/ARCHITECTURE.md`](../core/ARCHITECTURE.md) — engine
- [`packages/claw/ARCHITECTURE.md`](../claw/ARCHITECTURE.md) — sibling in-process plugin adapter
- [`packages/mcp/ARCHITECTURE.md`](../mcp/ARCHITECTURE.md) — sibling MCP adapter
