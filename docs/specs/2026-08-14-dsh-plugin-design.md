# `@plur-ai/dsh` — native DeepSeek Harness plugin

**Status:** draft for review
**Date:** 2026-08-14
**Owner:** Gregor

## Why

DeepSeek open-sourced DeepSeek Harness (`dsh`) on 2026-08-13. It reached 92.7k stars
in 26 hours and the `dsh-plugin` GitHub topic carries 2,151 repositories. Across its
219 packages there is **no memory or recall seam** — `ctx.storage` and
`ctx.storageDomain` are opaque key-value hubs and nothing owns cross-session
knowledge. Every other capability has a named seam. Memory is the hole.

The slot is contested but thinner than the star counts suggest. Of the apparent
competitors, `flowix` (276★) ships no `dsh` manifest key at all and `sivtr` (131★) is
a Rust CLI shipping skills. The only serious native entrants are
`dsh-memory-evolve` (53★) and **mnemon** (430★).

### The architectural opening

Mnemon's plugin is not mnemon's — it is `dsh-mnemon` v0.1.1, authored by `omdsh-dev`
and pinned by a nine-line wrapper bundle. Its own configuration reference documents
`recallMode: guided` as *"whether to inject an on-demand recall **cue**"* and
`writebackMode: guided` as *"inject the hot-memory cue"*.

So the market leader's recall path is:

```
agent/pre-step injects a hint
  -> model decides whether to call mnemon_recall
     -> tool spawns the Go CLI (cliPath, 10s hard timeout)
        -> SQLite read
           -> result returns as a tool message
              -> model continues
```

That is **model-mediated recall**: one extra round trip, one subprocess spawn, and a
compliance gamble every turn. It also registers **13 tools**, whose schemas dsh bills
on every request.

PLUR already does the other thing. `injectHybrid()` puts the actual engrams into the
prompt at assemble time — no tool call, no second round trip, no reliance on the
model taking a hint. This is not a feature difference, it is a difference in kind,
and it is the plugin's entire thesis:

> **Every other dsh memory plugin injects a cue. This one injects the memories.**

## Goals

1. Memory that works without the model asking for it, via direct content injection.
2. A curated tool surface, deliberately small, because schema cost is per-request.
3. Never take the host agent down. A memory layer that breaks someone's coding
   session is worse than no memory layer.
4. Feature parity with mnemon where parity is cheap (skills, commands, a Web tab).
5. Ship one package, publish once, list once.

## Non-goals

- Replacing `@plur-ai/mcp`. Power users wanting all ~40 tools keep using MCP; this
  plugin is the zero-configuration path and registers five tools.
- Multi-user or team-server features. Enterprise scoping stays where it is.
- Supporting dsh's Python SDK or ACP transports in v1.

## Package

One package, `packages/dsh` → **`@plur-ai/dsh`**, in the existing monorepo.

`pnpm-workspace.yaml` already globs `packages/*`. `@plur-ai/claw` is the precedent in
every respect: an external-harness plugin, its own manifest, its own independent
version track. Mnemon's two-package split exists only because a third party wrote
their plugin; a single package can declare both `dsh.bundle` and its plugin entry
point, as dsh's own publish tutorial shows.

```
packages/dsh/
├── package.json          # declares dsh.bundle + main
├── cordis.patch.yml      # the layer a profile applies
├── src/
│   ├── index.ts          # plugin: name, inject, Config, apply()
│   ├── inject.ts         # agent/pre-step direct injection
│   ├── learn.ts          # session/event correction detection
│   ├── capture.ts        # agent/turn-stopping episode capture
│   ├── compact.ts        # compaction/* learn-before-drop
│   ├── tools.ts          # the five model-facing tools
│   ├── skills.ts         # ctx.skills registration
│   ├── commands.ts       # /plur commands
│   ├── config.ts         # schemastery schema
│   ├── guard.ts          # timeout + never-throw wrapper
│   └── client/           # Web UI tab (ctx.slots)
└── test/
```

### Dependency posture

`@plur-ai/core`'s hard dependencies are light — PGlite (WASM, no native build),
`js-yaml`, `zod`. `better-sqlite3`, `@huggingface/transformers` and `pg` are all
**optional**. So the plugin runs PLUR **in-process** inside the dsh host rather than
shelling out to a binary the way mnemon does. That removes their per-call subprocess
spawn and their 10-second timeout ceiling.

dsh packages are on npm as release candidates (`@deepseek-ai/dsh-agent` 0.1.0-rc.6,
most others 0.0.1-rc.1, `@deepseek-ai/cordis` 4.0.1). They go in `peerDependencies`
with a pinned caret range plus `devDependencies` for tests. Given "THERE WILL BE
COMPATIBILITY-BREAKING CHANGES" in the README, a CI job builds against dsh `main`
weekly so drift surfaces as a red build, not a user bug report.

## Design

### 1. Direct injection — the core

Registered on the `agent/pre-step` waterfall with `{ prepend: true }`, following the
shape `@deepseek-ai/dsh-time-context` establishes:

```ts
ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
  const decision = await next()              // delegate FIRST
  if (decision.kind === 'reject' || signal.aborted) return decision
  const engrams = await guard(() => plur.injectHybrid({ ... }))
  if (!engrams) return decision              // degrade silently
  return {
    kind: 'enter',
    messages: [...decision.messages, createUserMessage({
      content: [{ type: 'text', text: render(engrams) }],
      source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [...] },
    })],
  }
}, { prepend: true })
```

**`form: 'snapshot'` is the mechanism that makes this safe.** dsh defines it as
*"current state, where a later snapshot from the same producer supersedes an earlier
one."* Injected context is a durable `user/message` in dsh's log and is otherwise
resent on every subsequent request until compaction — so a naive port of claw's
per-prompt-build injection would accrete an engram block per turn and quietly balloon
the user's context and bill. Snapshot form makes each injection supersede the last.

Two further guards on top:

- **Content-hash skip.** If the selected engram set hashes identically to the last
  injection, skip entirely. Avoids pointless supersession churn.
- **`refreshIntervalMs`.** A floor between injections, as `time-context` does, found
  by scanning back through `agent.session.events` for this plugin's last
  `user/message`.

Rendering reuses claw's `assembler.ts` / `system-prompt.ts` format verbatim.
Identical output across hosts is an existing PLUR principle and the MCP
session-start block already matches it.

**Open question for review:** dsh's docs emphasise KV-cache economics and note that
appended context is prefix-stable. A snapshot *supersession* may rewrite history
rather than append, which would invalidate cache from the changed token onward. If
so, `refreshIntervalMs` should default conservatively high, or injection should
prefer step 1 of a turn only. This needs measurement before defaults are fixed.

### 2. Auto-learn

`ctx.on('session/event', ...)`, filtered to `user/message` with `source.kind === 'user'`.
Runs claw's existing `learner.ts` heuristics (length filter, correction regexes,
sentence-level scan, polarity detection) and fires `plur.learnRouted()`
fire-and-forget at confidence ≥ 0.7. Never awaited on the turn path.

### 3. Episode capture

`ctx.on('agent/turn-stopping', ...)` — serial, no `next()`. Captures an episode
summary from the turn's last assistant message. Fire-and-forget.

### 4. Learn before drop

`ctx.on('compaction/start', ...)` extracts learnings from the range about to be
shadowed. This is claw's `compact` hook and the one place where memory earns its keep
most visibly, because the alternative is losing the content.

### 5. Subagent scope propagation

`ctx.on('subagent/start', ...)` propagates the parent's scope to the child, mirroring
claw's `prepareSubagentSpawn`.

### 6. Tools — five, not forty

Schema cost is billed per request while registered. Mnemon pays for 13. The MCP
server's ~40 would be indefensible.

| Tool | Why it earns its schema |
|---|---|
| `plur_recall` | Targeted lookup beyond what injection surfaced |
| `plur_learn` | Explicit store when the model knows something matters |
| `plur_forget` | Retire wrong knowledge — the editability differentiator |
| `plur_feedback` | Rate an injected engram; trains relevance. No competitor has this |
| `plur_status` | Health check, and how a user debugs "why didn't it remember" |

Everything else stays reachable through `@plur-ai/mcp` for users who want it.

### 7. Skills and commands

`ctx.skills.register()` contributes the existing `plur-memory` SKILL.md at runtime —
no filesystem provider needed. `ctx.commands` registers `/plur status` and
`/plur recall <query>`, which dispatch without a model turn.

### 8. Web UI tab

dsh's default profile *is* the web UI, so a plugin with no surface reads as
incomplete. Scope for v1 is deliberately small: one tab listing recent engrams, a
search box, and an enable/disable toggle. Built on `ctx.slots` plus a client module.
This is the largest single risk to the schedule (a second learning curve, in the
Cordis client graph and React) and is therefore built **last**, behind
`tabEnabled`, so it can be cut without blocking the release.

### 9. Configuration

Schemastery, registered under the `plur` namespace in `$DSH_HOME/settings.yaml`.

| Key | Default | Meaning |
|---|---|---|
| `path` | `~/.plur` | Store location |
| `injectionMode` | `content` | `content` \| `off`. There is deliberately no `cue` mode |
| `injectionBudget` | `2000` | Token ceiling for the injected block |
| `refreshIntervalMs` | `0` | Floor between injections; `0` means every eligible step. Raised to a non-zero default only if the KV-cache measurement below shows supersession is expensive |
| `autoLearn` | `true` | Correction detection |
| `autoCapture` | `true` | Episode capture |
| `scope` | unset | Default write scope |
| `reranker` | `off` | `off` \| `ms-marco-minilm-l6` \| `bge-reranker-v2-m3` |
| `timeoutMs` | `5000` | Hard bound on any PLUR call |
| `tabEnabled` | `true` | Web tab |

### 10. Failure discipline

This code runs inside someone else's coding agent. The governing rule:

> A PLUR failure must never fail the host's turn.

Concretely, enforced in `guard.ts` and asserted by tests:

- Every PLUR call is wrapped in a timeout (`timeoutMs`) and a `try/catch` that logs
  and returns `undefined`.
- `agent/pre-step` **always** calls `next()`, and on any internal error returns the
  delegated decision unmodified.
- All learning and capture paths are fire-and-forget (`void p.catch(...)`).
- A missing, corrupt, or unreadable store degrades to no-injection, not a throw.
- Plugin disposal cancels in-flight work and unregisters cleanly (Cordis effects).

## Testing

TDD throughout. Four layers:

1. **Unit** — pure functions: block rendering, budget trimming, content-hash skip,
   refresh-interval policy, learner heuristics. No Cordis.
2. **Plugin contract** — mount `apply()` in a minimal Cordis context with stub
   `ctx.agents` / `ctx.tools` / `ctx.skills`; dispatch `agent/pre-step` and assert the
   returned `PreStepDecision`. Includes the negative cases: PLUR throws, PLUR times
   out, decision is `reject`, signal aborted — all must return the delegated decision.
3. **End-to-end, deterministic** — `@deepseek-ai/dsh-llm-replay` is published, so a
   real dsh runtime can be driven with a recorded model stream and the session log
   asserted directly. This is the layer that proves injection actually reaches the
   model and that supersession behaves.
4. **Manifest contract** — assert `package.json`'s `dsh.bundle.patch`, the
   `cordis.patch.yml` row name, and the README install command stay in sync. Stolen
   directly from mnemon's `dsh_bundle_test.go`, which is a good idea.

## Release

A fifth independent version track, mirroring claw:

- `scripts/release.sh` gains `--dsh <ver>`, bumping `packages/dsh/package.json`,
  the version constant in `src/index.ts`, and the test assertion.
- `RELEASING.md`'s manifest gate gains the corresponding rows.

**Both land before the first publish**, not during it.

Published prebuilt to npm. A GitHub install would force users to allowlist an
install-time build script — permission to execute our code on their machine outside
any sandbox — which is a bad thing to attach to a memory product's first impression.

## Risks

| Risk | Mitigation |
|---|---|
| dsh breaking changes (stated in caps) | Pinned peer range; weekly CI against dsh main |
| KV-cache invalidation from supersession | Measure before fixing defaults; may restrict to step 1 |
| Embedder memory footprint in host process | Optional dep; hybrid→BM25 fallback already exists in claw |
| Cordis learning curve dominating the estimate | Reference plugins read (`time-context`, `agent-instructions`); Web tab built last and cuttable |
| DeepSeek ships its own `ctx.memory` seam | No evidence in-tree today. If it lands, being an early implementer of their interface beats being an early plugin — reassess immediately |

## Sequencing

Host plugin first, in dependency order: config and guard → injection → tools →
learn/capture/compact → skills and commands → Web tab. Injection is stage one because
it is the thesis; if only one thing ships, it is that.
