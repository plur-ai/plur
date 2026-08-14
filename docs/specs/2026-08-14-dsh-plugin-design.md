# `@plur-ai/dsh` — native DeepSeek Harness plugin

**Status:** revision 2 — incorporates a five-evaluator review (cto, dijkstra, taleb, ceo, popper)
**Date:** 2026-08-14
**Owner:** Gregor

> **Revision note.** Revision 1 claimed `form: 'snapshot'` made repeated injection safe by
> superseding earlier injections. **That was false**, and it was the load-bearing claim.
> `deriveEventMessage` in `packages/core/session/src/surface.ts:96` projects
> `user/message` as `return event.data` — verbatim, with no `form` check and no producer
> dedup. `form` is a presentation label consumed by a client renderer to pick an icon.
> Revision 2 abandons tail injection entirely in favour of a re-rendered system-prompt
> section, which has no accretion at all. See §1.

## Why

DeepSeek open-sourced DeepSeek Harness on 2026-08-13; 92,733 stars and 2,151
`dsh-plugin`-topic repositories as of 2026-08-14 (GitHub API, same date). Across its
219 packages there is no memory or recall seam.

**How that negative was established** (it is a universal claim and deserves its method
stated): dsh's generated `docs/capability-seams.md` enumerates every `ctx.*` service in
the tree with its owner, implementations and consumers — 60-odd entries covering
filesystem, shell, sandbox, subagents, compaction, skills, approval, web, LSP, storage.
No memory, recall, or knowledge service appears. A `grep` for `ctx.memory`,
`memorySeam` and `ctx.recall` across `packages/` and `docs/` returns nothing.
`ctx.storage` / `ctx.storageDomain` are opaque KV hubs with no semantic retrieval.
**Falsified by:** any `ctx.*` memory service appearing in that generated catalogue, or
a DeepSeek roadmap entry for one. Re-check before publish.

### The competitive opening — restated precisely

Revision 1 claimed "every other dsh memory plugin injects a cue." That was imprecise
and rested on examining one competitor. Both have now been read:

- **mnemon** (430★) — its plugin is `dsh-mnemon` v0.1.1, authored by `omdsh-dev`, not
  by mnemon. Its own configuration reference documents `recallMode: guided` as
  *"whether to inject an on-demand recall **cue**"*. It registers 13 tools and reaches
  its store through a CLI (`cliPath`, `timeoutMs` default 10000, documented as *"hard
  timeout for a single CLI call"*). Recall is therefore model-mediated: cue → the model
  decides → tool call → subprocess → result → continue.
- **dsh-memory-evolve** (53★) — `src/` contains only `client/`; every `inject` call is
  `ctx.slots.inject('conversation.view', …)`, i.e. UI slots. It registers **no
  `agent/pre-step` listener at all**. It is a Web-UI-plus-lifecycle-observer plugin.

The other apparent entrants are not memory plugins: `flowix` (276★) ships no `dsh`
manifest key; `sivtr` (131★) is a Rust CLI shipping skills.

So the defensible claim, and the one to use publicly:

> **Neither serious dsh memory plugin puts the memories themselves into the prompt.
> One injects a cue and makes the model ask; the other doesn't touch the request path.**

That is falsifiable, scoped to what was actually examined, and still the thesis.

### Where the competitor's design legitimately wins

Direct injection is not unconditionally superior and the spec should not pretend it is.
Roughly:

- ours ≈ `schema_tax(5 tools) + T_block` every turn
- theirs ≈ `schema_tax(13 tools) + T_cue + p · T_recall`, for `p` = P(model bites)

**When memory relevance is sparse (`p` low), the cue design is cheaper.** Ours wins when
relevance is dense, and when correctness matters more than marginal tokens — because
theirs fails silently whenever the model declines the cue, which is precisely the
"why didn't it remember?" complaint that destroys trust in a memory product. We are
trading a bounded, measurable token cost for the elimination of an unbounded
correctness gamble. That is the honest framing.

## Goals

1. Memory that works without the model asking for it.
2. A curated tool surface — five tools, because schema cost is per-request.
3. Never take the host agent down, and never silently inflate the user's bill.
4. Never move more of the user's memory off their machine than they intended.
5. Ship one package, publish once, list once.

### Success criterion

Two evaluators independently flagged that revision 1 had none, and that without one a
quiet launch is indistinguishable from a wrong thesis. Pre-registered:

- **Primary:** ≥ 250 npm downloads in the first 30 days *and* ≥ 1 unsolicited
  third-party mention (issue, blog, awesome-list entry we did not submit).
- **Secondary:** measured token overhead per turn within 1.5× of mnemon's at equal or
  better task success on a 20-task A/B run.
- **Reassess 2026-09-14.** If the primary is missed, the default action is to stop
  investing — keep the package alive at maintenance level, do not build v0.2.
- **Immediate abort:** DeepSeek announces a first-party memory seam. Then the play
  changes from "ship a plugin" to "be the reference implementation of their interface."

## Non-goals

- Replacing `@plur-ai/mcp` — power users wanting all ~40 tools keep using MCP.
- Team/server features. Enterprise scoping stays where it is.
- dsh's Python SDK or ACP transports.

## Package

One package, `packages/dsh` → `@plur-ai/dsh`, in the monorepo. `pnpm-workspace.yaml`
already globs `packages/*`; `@plur-ai/claw` is the precedent in every respect.

```
packages/dsh/
├── package.json          # dsh.bundle + main
├── cordis.patch.yml
├── src/
│   ├── index.ts          # name, inject, Config, apply()
│   ├── memory-section.ts # the system-prompt section + its async cache
│   ├── refresh.ts        # when to recompute the block
│   ├── scope.ts          # per-session scope resolution
│   ├── learn.ts          # correction detection off session/event
│   ├── capture.ts        # episode capture + learn-before-compaction
│   ├── tools.ts          # the five tools
│   ├── skills.ts         # ctx.skills registration
│   ├── commands.ts       # /plur commands
│   ├── config.ts         # schemastery
│   ├── guard.ts          # timeout + never-throw
│   ├── counters.ts       # local debug counters (NOT gated on the Web tab)
│   ├── session-log.ts    # shared log-walking helpers, unit-tested once
│   └── client/           # Web UI tab
└── test/
```

### Dependency posture

PLUR core's hard dependencies are light — PGlite (WASM), `js-yaml`, `zod`;
`better-sqlite3`, `@huggingface/transformers` and `pg` are optional. So PLUR runs
**in-process**, removing mnemon's per-call subprocess spawn.

dsh packages go in `peerDependencies`, pinned to one release line.

> **Verified 2026-08-14, and non-obvious:** the npm `latest` dist-tag is stale and
> internally inconsistent. `@deepseek-ai/dsh-tools@latest` is `0.0.1-rc.1`, which
> peer-requires `dsh-agent@^0.0.1-rc.1`, while `dsh-agent@latest` is `0.1.0-rc.6` —
> installing both fails with ERESOLVE. The current line is under the **`next`**
> dist-tag. Pin every `@deepseek-ai/dsh-*` to `0.1.0-rc.6` (cordis `^4.0.1`,
> schemastery `^3.18.1`); that resolves cleanly. Do **not** use `--legacy-peer-deps`.
> Published typings at that line match the git source, so we build against npm.

A weekly CI job builds against dsh `main` so drift is a red build, not a user report.

## Design

### 1. Memory as a re-rendered system-prompt section — the core

**Not** a tail-appended `user/message`. Revision 1's approach accretes: every injected
`user/message` stays in derived history verbatim and is resent on every subsequent
request until compaction, so with `refreshIntervalMs: 0` a long session would grow a
fresh ~2000-token block per step, forever. Nothing in dsh removes it —
`SurfaceOp.replace` is the only mechanism that shadows history, it requires naming the
exact seqs to shadow, and `PreStepDecision` (`{kind:'enter'; messages: UserMessage[]}`)
exposes no knob to set it. That road is closed.

Instead:

```ts
// registered per-agent, on that agent's scoped context
agent.ctx.systemPrompt.section({
  name: 'plur:memory',
  order: 120,                       // after persona (0), alongside tool guidance
  text: () => cache.get(agent.id) ?? '',   // SYNCHRONOUS read of a cached block
})
```

`PromptSection.text` may be *"a provider evaluated at each assembly"*
(`packages/core/system-prompt/src/index.ts`). So the block is re-rendered from cache on
every request and **never accumulates**. Registration is scoped and returns a Cordis
disposer, so it unwinds with the agent.

The `text` provider is synchronous and `injectHybrid()` is async, so the cache is
refreshed **out of band**:

- On `agent/pre-step`, at **turn boundaries only** (step 1), fire-and-forget:
  recompute the block, write it to the cache. The current turn renders whatever is in
  cache; the next turn sees the update. One recall per user turn is the natural cadence
  and it means retries and multi-step tool loops never trigger extra recalls.
- Content-hash gate: if the newly selected engram set hashes to what is already cached,
  **do not write** — an unchanged system prompt keeps the KV-cache prefix stable.

**The tradeoff moved, and improved.** Revision 1 risked unbounded, silent context
growth. Revision 2 risks KV-cache prefix invalidation when the memory block *changes* —
bounded, measurable, gated by the content hash, and worst-case it costs one cache miss
on a turn where memory genuinely changed. A stale-by-one-turn block is a far better
failure mode than an exploding bill.

Rendering reuses claw's `assembler.ts` / `system-prompt.ts` format. A snapshot test
asserts byte-identity with claw's and MCP's rendered block, since "identical output
across hosts" is claimed as a principle and should therefore be enforced.

### 2. Per-session scope resolution

A single global `scope` config is wrong: dsh's default profile is the multi-session web
server, so two unrelated project sessions in one dsh instance would draw from and write
to the same PLUR scope — engrams from one project leaking into another's context. Claw
already solves this with a `Map<sessionKey, scope>`; `scope.ts` does the same, keyed by
`agent.id`, resolved from (in precedence order) explicit config → the session's `cwd`
(a `.plur.yaml` in the workspace root) → the configured default.

### 3. Scope gate and disclosure — what leaves the machine

An engram block injected into a dsh request goes to whatever provider the host is
configured with. dsh's onboarding pre-populates exactly one provider card, and
`packages/llm/llm-deepseek/src/index.ts` sets
`PUBLIC_BASE_URL = 'https://api.deepseek.com'`. So the default path sends memory content
to DeepSeek's hosted API.

This is not a new *class* of exposure — every PLUR adapter injects content into the
host's model traffic, and `docs/telemetry-design.md`'s "no content capture" rule governs
PLUR's own phone-home telemetry, not the user's model provider. But two things follow
that revision 1 got wrong:

- **The store must be gated by scope, defaulting closed.** With `scope` unset, the
  ambient global store is eligible — and a global store accretes across every tool a
  user has ever pointed PLUR at, including (per this installation's own conventions)
  server IPs, SSH configs and client names. A third-party harness must not inherit all
  of that by default. Default to a dsh-specific scope; broadening is an explicit act.
- **First-run disclosure.** One line in the README and one on first activation:
  *"PLUR includes your stored memories in requests sent to your configured model
  provider — for a default dsh install that is DeepSeek's hosted API. Change the
  provider, narrow the scope, or set `injectionMode: off` in settings."* We advertise
  "your conversations never leave your machine" in claw's own README; we do not get to
  be vague here.

`injectionMode` stays defaulted to `content`. Defaulting it off would disable the
product's thesis and contradicts every other PLUR adapter. Disclosure plus a scope gate
addresses the real risk; disabling the feature addresses it by not shipping it.

### 4. Auto-learn, capture, and learn-before-compaction

All off the `session/event` emit feed, whose listener failures dsh explicitly contains.

- **Auto-learn** — filter `user/message` with `source.kind === 'user'`, run claw's
  `learner.ts` heuristics, fire-and-forget `plur.learnRouted()` at confidence ≥ 0.7.
- **Episode capture** — on `agent/turn-stopping` (serial, no `next()`).
- **Learn before drop** — `compaction/start` is a `SessionEventMap` entry, **not** a
  Cordis event; `ctx.on('compaction/start', …)` does not exist. Filter it out of
  `session/event`: `if (evt.type !== 'compaction/start') return`. It does fire before
  summarization, so reading pre-shadow content is sound.

**Concurrency.** Two live sessions in one process can fire auto-learn against the same
YAML store simultaneously — a hazard the subprocess-per-call competitor does not have
and that our in-process choice introduces. All writes go through a single in-process
serialization queue in `guard.ts`. Not last-write-wins by accident.

### 5. Subagent scope propagation

`subagent/start` is documented as observe-only and fires *after* the child is published
— it is **not** claw's pre-spawn `prepareSubagentSpawn`, and revision 1 overstated the
parity. Whether the scope write lands before the child's first assembly is a real
timing question, so this ships only with a layer-3 test proving the child's first
rendered prompt reflects the inherited scope. If the test can't be made to pass, the
feature is cut rather than shipped on the strength of an analogy.

### 6. Tools — five

| Tool | Why it earns its schema |
|---|---|
| `plur_recall` | Targeted lookup beyond what the section surfaced |
| `plur_learn` | Explicit store |
| `plur_forget` | Retire wrong knowledge — the editability differentiator |
| `plur_feedback` | Rate an engram; trains relevance. No competitor has this |
| `plur_status` | Health, and how a user debugs "why didn't it remember" |

### 7. Skills, commands, counters, Web tab

`ctx.skills.register()` contributes the existing `plur-memory` SKILL.md.
`ctx.commands` registers `/plur status` and `/plur recall <query>`.

`counters.ts` keeps claw's per-event counters (`injects_attempted`, `engrams_injected`,
`errors_swallowed`, …) and is **independent of the Web tab** — if the tab is cut, a
human-facing debugging surface must still exist.

The Web tab (one tab: recent engrams, search, toggle) is built last, behind
`tabEnabled`. It surfaces engram content inside a third-party UI, so it inherits §3's
scope gate.

### 8. Configuration

| Key | Default | Meaning |
|---|---|---|
| `path` | `~/.plur` | Store location |
| `scope` | dsh-specific scope | **Gated.** Not the ambient global store |
| `injectionMode` | `content` | `content` \| `off` |
| `injectionBudget` | `2000` | Provisional, pending measurement. Measured with `ctx.tokenMeter` so our budget and the host's agree |
| `refreshIntervalMs` | `0` | Floor between cache refreshes; `0` = once per turn boundary, which is the cadence, not every step |
| `autoLearn` / `autoCapture` | `true` | |
| `reranker` | `off` | `off` \| `ms-marco-minilm-l6` \| `bge-reranker-v2-m3` |
| `timeoutMs` | `5000` | Provisional. Hard bound on any PLUR call |
| `tabEnabled` | `true` | Web tab |

### 9. Failure discipline

> A PLUR failure must never fail the host's turn, and never silently inflate the bill.

- **Everything** PLUR-side runs inside `guard()` — including *rendering*, not just
  retrieval. Revision 1's own code sample called `render(engrams)` outside the guard;
  that is exactly the bug the rule exists to prevent.
- The prompt-section `text` provider is synchronous, cache-only, and cannot throw: it
  returns `''` on any miss.
- All learning and capture are fire-and-forget.
- A missing or corrupt store degrades to an empty block.
- Disposal cancels in-flight work and unwinds registrations via Cordis effects.
- **Known limit, stated rather than papered over:** the reranker path
  (`@huggingface/transformers`, peak RSS ≈ 2GB for bge) is native/WASM; an OOM or
  native crash there cannot be caught by a JS `try/catch` and would take the host
  process down. It stays defaulted `off`, and enabling it is documented as
  "for local/batch use, not inside a shared agent host."

## Testing

TDD. Four layers:

1. **Unit** — block rendering, budget trimming, content-hash gating, refresh policy,
   scope resolution, and `session-log.ts`'s log-walking helpers (the exact category
   where the review found two bugs). No Cordis.
2. **Plugin contract** — mount `apply()` in a minimal Cordis context with stubs;
   assert registration, and the negative paths: PLUR throws, PLUR times out,
   **render throws after a successful recall**, decision is `reject`, signal aborted,
   retry storm within one step, plugin disposed mid-flight.
3. **Deterministic E2E** — `@deepseek-ai/dsh-llm-replay@0.1.0-rc.6` is published, so a
   real dsh runtime runs against a recorded stream. This layer proves the section
   actually reaches the model, that a multi-turn session does **not** accrete, and that
   an inherited subagent scope reaches the child's first assembly.
4. **Manifest contract** — `dsh.bundle.patch`, the patch row name and the README
   install command stay in sync.

## Estimate

Not previously stated, and the urgency argument is meaningless without one. For one
engineer new to Cordis: **6–9 working days** — 1 setup and config, 2 the memory section
and its cache, 1 scope and tools, 1 learn/capture/compaction, 1 skills/commands/counters,
2–3 Web tab. The tab is the variable and the cuttable part.

## Risks

| Risk | Mitigation |
|---|---|
| dsh breaking changes (announced in caps) | One-line pin; weekly CI against `main` |
| KV-cache invalidation on block change | Content-hash gate; turn-boundary cadence; measure in layer 3 |
| **Memory content reaches the host's model provider — DeepSeek by default** | Scope gate defaulting closed; first-run disclosure; `injectionMode: off` available |
| Reranker native crash takes the host down | Default `off`; documented as unsuitable for a shared host |
| Concurrent writes from multiple sessions | Single serialization queue for all writes |
| Cordis learning curve | Reference plugins read; tab built last and cuttable |
| DeepSeek ships `ctx.memory` | Re-check the seam catalogue before publish; if it lands, pivot to reference implementation |

## Sequencing

Config and guard → memory section and cache → scope → tools → learn/capture/compaction
→ skills/commands/counters → Web tab. The memory section is stage one because it is the
thesis; if only one thing ships, it is that.
