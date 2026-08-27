<p align="center">
  <a href="https://plur.ai"><img src="assets/plur-banner.png" alt="PLUR — local-first shared memory for AI agents. Haiku + PLUR beats Opus without it, at ~10× less cost." width="100%"></a>
</p>

# PLUR — Your agents share the same memory

[![MCP Toplist](https://mcptoplist.com/badge/io.github.plur-ai%2Fplur.svg)](https://mcptoplist.com/server/io.github.plur-ai%2Fplur)

[![npm version](https://img.shields.io/npm/v/@plur-ai/core?logo=npm&color=cb3837)](https://www.npmjs.com/package/@plur-ai/core)
[![CI](https://img.shields.io/github/actions/workflow/status/plur-ai/plur/ci.yml?branch=main&logo=github&label=CI)](https://github.com/plur-ai/plur/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/github/license/plur-ai/plur?color=blue)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/plur-ai/plur?style=social)](https://github.com/plur-ai/plur/stargazers)
[![Glama score](https://glama.ai/mcp/servers/plur-ai/plur/badges/score.svg)](https://glama.ai/mcp/servers/plur-ai/plur)

Persistent, **open** memory for AI agents — local-first, zero-cost, shared across MCP tools (Claude Code, Codex, Cursor, Hermes, OpenClaw). Your agent's memory is plain-text **engrams** you can read, correct, and delete — not weights you can't.

[plur.ai](https://plur.ai) · [Benchmark](https://plur.ai/benchmark.html) · [Engram Spec](https://plur.ai/spec.html) · [npm](https://www.npmjs.com/org/plur-ai) · [Comparisons](comparisons/)

## Benchmarks

PLUR is memory, not just retrieval — so we measure it on more than one axis, on the **full** corpus, and we publish the harness so you can reproduce every number.

**Retrieval recall — full LongMemEval-S (N=500), R@5, fully local:**

| Stack | R@5 | Notes |
|-------|-----|-------|
| BM25 only | 92.2% | no embedder — fully airgapped |
| Hybrid (BGE-small, shipping default) | 95.6% | bundled local embedder, zero downloads |
| **+ BGE-reranker-v2-m3** | **97.6%** | local cross-encoder, max quality — opt-in, ≈5s p50 on CPU |

Numbers come from [plur-ai/plur-bench](https://github.com/plur-ai/plur-bench),
which is the source of truth for every benchmark figure PLUR publishes. Where
an in-repo number and a plur-bench number disagree, plur-bench wins — it is the
reproducible harness, and it is what CI regression-checks.

Chunk granularity, canonical-doc scoring, corpus SHA256 pinned — reproduce it in [plur-ai/plur-bench](https://github.com/plur-ai/plur-bench). No cloud call is required for any of these numbers (an *optional* cloud embedder, openai-3-large, reaches 97.0% hybrid). A faster reranker — `ms-marco-minilm-l6` (p50≈245ms vs BGE's ≈5s on CPU) — trades a little recall for sub-second latency.

**Run it yourself — and tell us what you get.** The harness is [plur-ai/plur-bench](https://github.com/plur-ai/plur-bench): CPU-runnable, no API key needed for the local path, corpus auto-fetched and SHA-verified. If you run it, we'd genuinely love to see your numbers — open an issue or discussion with your results, **especially if they don't match ours.** Independent reproduction is worth more than any number we publish, and we'll gladly credit you.

**Retrieval ≠ answer accuracy — and we report them separately, never conflated.** End-to-end (LLM-judge) answer accuracy with the reranker stack is **60.5%**, versus **52.0%** for dumping full context into the prompt and **5.5%** with no memory at all.

**Agent-task impact** — same task, with memory vs without: Haiku + PLUR outperforms Opus *without* it at roughly **10× less cost**; house rules **12–0** across Haiku, Sonnet, and Opus.

**Operational** — local-first, zero-cost search, data-sovereign by design.

*More in progress: LoCoMo, agentic task suites, cross-tool portability, decay / contradiction correctness.* [Full methodology →](https://plur.ai/benchmark.html)

## The idea

You correct your agent's coding style on Monday. On Tuesday, it makes the same mistake. You explain your architecture in Cursor. That night, Claude Code has no idea.

PLUR fixes this. Install it once, and corrections, preferences, and conventions persist — across sessions, tools, and machines. Your memory is stored as plain YAML on your disk. No cloud, no API calls, no black box.

The interesting part: in our tool-routing and local-knowledge benchmark, **Haiku with PLUR memory outperformed Opus without it** — 2.6x better on tool routing, at roughly 10x less cost. Turns out the bottleneck isn't model intelligence. It's context.

**The model is rented; your memory is owned.** Swap Haiku for Opus for whatever ships next month — the reasoning is a commodity you don't control. The part that's *yours* — everything the agent has learned about your work, your corrections, your conventions — shouldn't live in someone else's cloud or be baked into weights you can't read. PLUR keeps it in plain files on your disk, in an open format you can inspect, correct, and delete. That's what owning your intelligence actually means.

## Install

### Tell your agent

Paste this to your coding agent (Claude Code, Cursor, Windsurf, OpenClaw):

```text
Set up PLUR memory for me: run `npx @plur-ai/mcp init`, then check my PLUR status to confirm it works.
```

Prefer a guided setup? [plur.ai](https://plur.ai) has the exact config for your tool — Claude Code, Cursor, Windsurf, or OpenClaw.

### Manual setup (Claude Code)

One command sets up everything — storage, MCP config, and Claude Code hooks:

```bash
npx @plur-ai/mcp init
```

This creates `~/.plur/` for storage, adds PLUR to your `.mcp.json`, and installs Claude Code hooks for automatic engram injection. The hooks also **auto-close the memory lifecycle**: a `SessionEnd` hook captures a closing episode and cleans up session state when a conversation ends, so memory closes cleanly even if the agent forgets to call `plur_session_end`. PLUR is installed **globally** — one MCP server, one store, available in every project. You only run init once.

For **multi-project setups**, use domain/scope to separate knowledge:

```bash
cd ~/projects/my-app
npx @plur-ai/cli init --domain myapp --scope project:my-app
```

This creates a `.plur.yaml` in the project with defaults that hooks apply automatically. Engrams learned in that project are tagged; recall filters by scope but always includes global knowledge.

**Set scope per engram, by content.** Scope is not a once-per-session setting — every `plur_learn` call takes its own `scope`, chosen from what the engram is about. Team/shared knowledge goes to a team scope (e.g. `group:<org>/<team>`, used by PLUR Enterprise); project details to `project:<name>`; personal preferences stay local. Don't let team-relevant knowledge fall back to `global` by omitting scope — `global` leaks into every project and (with a team store configured) never reaches the team. `plur_session_start` lists the remote scopes a token can write to.

### Global install (faster startup)

```bash
npm install -g @plur-ai/mcp
plur-mcp init
```

### Cursor

Run init from your project root — it sets up Cursor's `.cursor/mcp.json` (plus Cursor hooks and a context rule):

```bash
npx @plur-ai/mcp init
```

PLUR runs under a **lean tool profile** in Cursor (`PLUR_TOOL_PROFILE=cursor`) — Cursor caps the tools a workspace can expose, so PLUR surfaces a curated core set (learn / recall / inject / status) instead of all 42, with the rest reachable through `plur_admin`. Cursor support shipped in v0.13.

### Codex

```bash
npx @plur-ai/cli init --codex
```

Registers the MCP server via `codex mcp add`, writes lifecycle hooks to `~/.codex/hooks.json`, and adds a PLUR section to `AGENTS.md`. Auto-detected when `~/.codex/` exists.

Injection uses hybrid search (BM25 + embeddings) with an automatic BM25 fallback if the embedder is slow or unavailable. Set `PLUR_HOOK_HYBRID=0` to force BM25 (applies to the Antigravity hooks too; `PLUR_CODEX_HYBRID` is honoured as an alias). `PLUR_HOOK_HYBRID_DEADLINE_MS` tunes the fallback deadline — keep it below your harness's hook timeout (Codex 25s, Antigravity 20s).

**One manual step after install:** open Codex, run `/hooks`, and trust the PLUR entries. Codex fingerprints every hook and refuses to run untrusted ones — *silently*, with no warning and a zero exit code. Until you trust them, memory simply never loads. `plur doctor` says so too.

### Which integration you get

Every MCP client can call PLUR's tools. Only some have an *adapter* — the hooks
and always-on context that make memory load automatically instead of waiting for
the agent to think of it. Without one, recall and learning depend entirely on the
model choosing to call the tools, which degrades badly under context pressure.

| Harness | Tools | Auto-injection + enforcement |
|---|---|---|
| Claude Code | ✅ | ✅ hooks + `CLAUDE.md` |
| Codex | ✅ | ✅ hooks + `AGENTS.md` (trust `/hooks` once) |
| Cursor | ✅ | ✅ hooks + rules |
| OpenClaw | ✅ | ✅ ContextEngine plugin |
| Hermes | ✅ | ✅ plugin |
| Antigravity CLI (`agy`) | ✅ | ✅ hooks + `AGENTS.md` |
| Windsurf, Gemini CLI, other MCP clients | ✅ | ❌ tools only |

If your harness is in the last row, paste the PLUR section from `CLAUDE.md` into
its own context file (`AGENTS.md`, `GEMINI.md`, …) as an interim measure — that
restores the instruction layer, though not automatic injection.

### Antigravity CLI (agy)

```bash
npx @plur-ai/cli init --antigravity
```

Writes hooks and the MCP server into agy's global config (`~/.gemini/config/`) and adds a PLUR section to `AGENTS.md`. Auto-detected when `~/.gemini/antigravity-cli/` exists. No trust step — agy runs configured hooks on first invocation; just restart agy.

Antigravity has no session-start event and no per-prompt hook, so PLUR drives everything from `PreInvocation`: per-prompt recall is read from the conversation transcript, and the turn's memory is re-injected as an ephemeral message on every model invocation so it survives tool calls without accumulating in history.

Gemini CLI users: Google is transitioning Gemini CLI to Antigravity — install `agy` and run the command above. Gemini CLI itself remains tools-only.

### OpenClaw

```bash
openclaw plugins install @plur-ai/claw
openclaw config set plur.enabled true
```

That's it. PLUR works in the background from here. No workflow changes needed — just use your tools as usual. Corrections accumulate automatically.

### DeepSeek Harness

```bash
dsh plugin add @plur-ai/dsh
```

Native, not an MCP bridge. PLUR mounts as a Cordis plugin and writes your
engrams straight into the system prompt, so the model reads them the way it
reads its own instructions — no tool call, no round trip, and no turn spent
deciding whether to look. The section is re-rendered on each assembly rather
than appended, so memory does not accumulate in the context as a session runs.

Five tools (`plur_recall`, `plur_learn`, `plur_forget`, `plur_feedback`,
`plur_status`) are still registered for when the agent wants to reach for
memory deliberately. Scope defaults closed — each workspace gets its own,
resolved from its `.plur.yaml`.

`/plur` reports status; `/plur-memory` opens the memory viewer below.

### Hermes Agent

```bash
pip install plur-hermes
npm install -g @plur-ai/cli
```

The plugin registers automatically via Hermes' plugin system. It injects relevant memories before each LLM call, extracts learnings from agent responses, and exposes all PLUR tools to the agent. Hermes shells out to the PLUR CLI.

### Python SDK (LangChain, llama.cpp, scripts)

For Python environments that aren't Hermes:

```bash
pip install "plur-ai @ git+https://github.com/plur-ai/plur.git#subdirectory=packages/python"
npm install -g @plur-ai/cli   # bridge (required)
```

> **Note:** `plur-ai` is not yet on PyPI — use the git install above until [#915](https://github.com/plur-ai/plur/issues/915) is resolved.

```python
from plur_ai import Plur

plur = Plur()
plur.learn("always use async generators for streaming LLM output")
results = plur.recall("streaming patterns")
context = plur.inject("write a streaming endpoint", limit=10)
```

`plur-ai` bridges to the same on-disk store as Claude Code and OpenClaw — memory written from Python is immediately visible across all your tools. See [`packages/python/examples/`](packages/python/examples/) for LangChain and llama.cpp integration examples.

### Verify it works

Ask your agent: *"What's my PLUR status?"* — it should call `plur_status` and return your engram count and storage path.

### Read your memory

```bash
plur dashboard
```

Opens a local page listing every engram: what was learned, what actually gets
recalled, and how often. Read-only, loopback-only, and served from your own
machine — nothing is uploaded. `--port` moves it, `--no-open` skips the
browser. Inside DeepSeek Harness the same page is one `/plur-memory` away.

Available in English and 中文; it follows your browser, or `?lang=zh`.

### See it in action

Once it's running, teach your agent something once:

> *"Always use `pnpm` in this project — `npm install` breaks the lockfile in CI."*

Start a new session the next day and ask:

```
You: How do I run the tests?

<plur-memory> 1 engram · project:my-api </plur-memory>

Agent: Use pnpm — you mentioned npm breaks the lockfile in CI:

  pnpm test                           # full suite
  pnpm test -- src/auth.test.ts       # single file
```

New session. No reminder. The correction was there.

That's the moment PLUR pays off — the agent remembers a project convention you mentioned once, without it being in any file it can read.

## How it works

PLUR has two storage primitives:

**[Engrams](https://plur.ai/spec.html)** — learned knowledge that persists across sessions. Each engram is a typed assertion ("always use blue-green deploys", "never force-push to main") with:

- **Activation** — retrieval strength that decays over time (ACT-R model) and strengthens on access. Stale facts naturally fade from injection without manual cleanup.
- **Feedback signals** — positive/negative ratings that train injection quality over time
- **Scope** — hierarchical namespace (`global`, `project:myapp`, `cluster:prod`, `service:api`) controlling where the engram applies
- **Polarity** — automatic classification of "do" vs "don't" rules, so constraints are injected separately from directives
- **Associations** — links to other engrams, including co-access edges that form automatically when engrams are recalled together

**Episodes** — timestamped event records for "what happened when." Each episode captures a summary, timestamp, agent attribution, and channel. Use episodes for incident timelines, session logs, and operational history. Query by time range, agent, or channel.

```
You correct your agent  →  engram created  →  YAML on your disk
Agent fixes an incident →  episode captured →  timeline searchable
Next session starts     →  relevant engrams injected  →  agent remembers
You rate the result     →  engram strengthens or decays  →  quality improves
Unused engrams          →  activation decays  →  naturally fade from injection
```

Search is fully local: BM25 (with IDF weighting, TF saturation, length normalization) + BGE embeddings + Reciprocal Rank Fusion. Zero API calls, zero per-query cost. [Benchmark methodology →](https://plur.ai/benchmark.html)

Plugins (OpenClaw, Hermes) automatically capture learnings from agent conversations — no manual saving needed. The agent's corrections become engrams without you doing anything.

See the [full engram spec](https://plur.ai/spec.html) for schema details, activation model, and injection algorithm.

## Open format

The engram is an **open, versioned format** — not a black box. Every engram is plain YAML validated against a published [JSON Schema](https://plur.ai/spec.html), generated from the same Zod source the engine uses (the schemas live in [`spec/`](spec/)). Read it, diff it in git, write your own tooling against it, or build a different engine on the same format — your memory isn't locked to PLUR.

## Usage

```typescript
import { Plur } from '@plur-ai/core'

const plur = new Plur()

// Learn from a correction. The engine's read and write methods are async —
// they return promises so a `Plur` can be backed by a network store as well
// as by the default local YAML one.
await plur.learn('toEqual() in Vitest is strict — use toMatchObject() for partial matching', {
  type: 'behavioral',
  scope: 'project:my-app',
  domain: 'dev/testing'
})

// Recall (hybrid: BM25 + embeddings, zero cost)
const results = await plur.recallHybrid('vitest assertion matching')

// Inject relevant engrams into agent context. You get context blocks ready to
// paste into a prompt plus the IDs that went into them — not the engrams
// themselves. `budget` is the ceiling in tokens; selection fills it by relevance.
const injection = await plur.inject('Write tests for the user service', {
  scope: 'project:my-app',
  budget: 2000
})
console.log(injection.directives)   // also .constraints, .consider
console.log(`${injection.count} engrams, ${injection.tokens_used} tokens`)

// Feedback trains the system — rate anything you have an ID for, whether it came
// back from recall or went out in an injection (injection.injected_ids).
if (results[0]) await plur.feedback(results[0].id, 'positive')

// Capture an event (episode). Episode operations stay synchronous — they are
// backed by episodes.yaml, not the engram primary store.
plur.capture('Fixed CrashLoopBackOff on bee-3-4 by increasing memory limits', {
  agent: 'claude-code',
  channel: 'terminal'
})

// Query timeline
const incidents = plur.timeline({ agent: 'claude-code' })

// Sync across machines (use a private git remote — all engrams including private-visibility ones are pushed)
await plur.sync('git@github.com:you/plur-memory.git')
```

## Tools

| Tool | What it does |
|------|-------------|
| `plur_learn` | Store a correction, preference, or convention |
| `plur_learn_batch` | Store many engrams in one call (batch dedup + per-item failure isolation) |
| `plur_recall` | Retrieve relevant memories — hybrid (BM25 + embeddings) by default; `mode:"keyword"` for BM25-only |
| `plur_inject_hybrid` | Select engrams for current task within token budget |
| `plur_feedback` | Rate relevance (trains quality over time) |
| `plur_forget` | Retire a memory (activation decays, eventually pruned) |
| `plur_rescope` | Move an existing engram to another scope — personal → team, or back |
| `plur_session_scope` | Change the session's default write scope mid-session |
| `plur_capture` | Record an event — incident, resolution, session milestone |
| `plur_timeline` | Query episode history by time, agent, or channel |
| `plur_ingest` | Extract engrams from text automatically |
| `plur_sync` | Sync via git. `personal` remotes mirror everything (use a private repo); `shared` remotes receive only shared-scope, non-private engrams |
| `plur_status` | Check system health and engram counts |
| `plur_receipt` | Counted, local report of what your memory retrieved for you |
| `plur_outbox` | Inspect (and retry) team writes queued while their store was unreachable |

### The outbox

A write to a team scope goes to that team's remote store. When the store cannot
be reached — VPN off, server down, token expired — the engram is **not lost and
not silently dropped**: it is written locally with queue metadata and retried on
the next session start, on `plur sync`, or on demand.

The queue is not a directory. It lives as `structured_data._outbox` inside the
affected engrams in `engrams.yaml`, which is why it needs a command to see:

```
plur outbox            # what is queued, for which scope, how long, last error
plur outbox --flush    # retry now
```

The same thing is available to agents as `plur_outbox` (`{flush: true}` to
retry), and `plur status` reports the pending count. Neither surface prints the
target URL or the token.

## The memory receipt

`plur receipt` (and the `plur_receipt` MCP tool) show what your memory actually did — counted from PLUR's own retrieval history, never estimated:

```
Your Memory Receipt
===================
  2026-07-03 .. 2026-07-22  (71 sessions)

  423 times a memory you taught PLUR
  was put in front of the model.
  (plus 45 times an installed-pack memory)

  across 71 retrievals in 71 sessions
  drawing on 162 distinct engrams

  MOST-RELIED-ON
      34x  PLUR positioning thesis across every vertical: PLUR layers …
      28x  Datacore app CoS architecture: reasoning layer added on to…
      ...

  STORE HEALTH
       4,517   engrams stored (you: 3,746, packs: 771)
         162   retrieved at least once (4% of store)
       4,355   not retrieved since 2026-07-03 (96%)
    Over a short logging window a low rate is expected, not a fault —
    memory is meant to be selective, and much of the store predates logging.
```

(REUSE stats and coverage caveats are also shown; trimmed here for length.)

It is local and read-only, and carries **no dollar or token figure by design**: on a subscription your marginal token cost is zero, and the value of an avoided rediscovery is not measurable from this data. The receipt reports only what it can count. Activation rate is store *coverage over the logging window*, not a quality score — it is naturally low and falls as you add engrams. `--days N` narrows the window; `--json` emits the raw shape. (The `plur_receipt` MCP tool returns the same figures plus a one-line `summary` that carries this framing to the agent.)

## Syncing across devices

`plur.sync(remote)` is git underneath: it commits your engram store and pushes it to the remote you give it. What gets pushed depends on the remote's declared type (`sync.remote_type` in `config.yaml`, or the `remote_type` argument):

- **`personal`** (default) — your own backup/mirror across your machines. The remote receives everything that is pushed, **including `visibility: private` engrams**: private visibility means "don't share this in a pack", not "don't mirror it to my own devices", so private engrams intentionally follow you from machine to machine. Because of that, **always use a private git remote** (a private GitHub/GitLab repo, or your own server). PLUR surfaces a `warning` in the sync result whenever private engrams are present. Never point a personal sync at a public repository.
- **`shared`** — a team-visible remote. Only engrams with a **shared-family scope** (`group:`/`project:`/`space:`/`team:`/`org:`/`public`) **and a non-private visibility** are pushed; personal-family engrams (`local`, `global`, `user:*`, `agent:*`) and private-visibility engrams never reach the remote, by construction. Note the default visibility is `private`, so a shared remote receives only engrams whose visibility was set deliberately — teammates get what you chose to share, nothing else. The same guarantee covers the sibling store files (#686): an episode, candidate, or tension record is pushed only when every engram it references is itself in the push set — records derived from personal or private engrams (a tension's statement snapshots, a failure-report episode) stay local, as does any record referencing an engram the filter cannot resolve.

In both modes **`scope: local` engrams** are machine-specific by design (paths, local ports, per-host quirks), so they are stripped from every commit and never reach any remote. Stripping happens on the *staged blob*: your local working copy always keeps every engram.

## Benchmark details

Per-category retrieval recall, from an **earlier in-repo run** — full
LongMemEval-S (N=500), fully local (BGE-small + BGE-reranker-v2-m3, chunk
granularity). Its overall figure (98.0%) predates the current plur-bench
measurement of the same stack (97.6%) and has not been re-run per category;
treat the shape as indicative and the headline table above as current.

| Category | R@5 | R@10 |
|----------|-----|------|
| single-session-assistant | 100.0% | 100.0% |
| knowledge-update | 100.0% | 100.0% |
| single-session-user | 98.6% | 100.0% |
| multi-session | 98.5% | 100.0% |
| temporal-reasoning | 97.7% | 98.5% |
| single-session-preference | 86.7% | 90.0% |
| **overall** | **98.0%** | **99.0%** |

Retrieval recall (finding the right memory) and end-to-end answer accuracy (whether the model then answers correctly) are **different axes** — PLUR measures and reports them separately, never conflated. The agent-impact figures above come from a same-task A/B run (memory vs none).

[Full methodology →](https://plur.ai/benchmark.html)

## PLUR vs other agent-memory tools

Mem0, Letta (MemGPT), and Zep solve real problems — a drop-in memory API (Mem0), a self-managing agent OS (Letta), a temporal knowledge graph (Zep). PLUR's bet is a combination none of them ship together:

- **Plain-text you own** — engrams are human-readable YAML you can read, `git diff`, edit, and provably delete. Not opaque vectors, agent-state blocks, or graph nodes you need tooling to inspect.
- **Local-first, zero-cost** — hybrid BM25 + local embeddings, fully offline, no API bill (98% R@5 on the full LongMemEval-S corpus with no cloud call — see above).
- **Team-shareable via git** — `plur sync` is git underneath, so the same memory follows you across machines *and* across a team. Most tools are single-user-local *or* cloud-team; PLUR is both, and you keep the data.
- **Cross-tool** — the same `~/.plur/` store works in Claude Code, Cursor, Windsurf, OpenClaw, and Hermes. Your memory isn't trapped in one vendor.
- **It learns and forgets** — feedback-trained retrieval with ACT-R decay and an on-demand contradiction scan, not a grow-forever store.

If you need a hosted memory API or a temporal knowledge graph, use the tool built for that. If you want memory you can **read, own, share with your team, and move between tools**, that's PLUR. Side-by-side detail: [comparisons/](comparisons/).

## What PLUR is — and isn't

PLUR is **agent memory** — it stores corrections, preferences, conventions, and architectural decisions that an AI agent learns during work sessions, and injects them back when they're relevant.

PLUR is **not** a general-purpose search engine, a codebase indexer, or a replacement for code intelligence tools. It doesn't parse ASTs, navigate class hierarchies, or search your source files. If you need code-aware search (tree-sitter, language server features, symbol lookup), tools like [claude-mem](https://github.com/skydeckai/claude-mem) or your IDE's built-in search are the right choice.

The two are complementary:

| | PLUR | Code intelligence tools |
|---|------|------------------------|
| **Stores** | Learned knowledge (engrams) + event timeline (episodes) | Code structure, symbols, definitions |
| **Search** | Engram recall (BM25 + embeddings over memory) | AST traversal, symbol lookup, semantic code search |
| **Learns** | From agent corrections, feedback, usage patterns | From static analysis of source code |
| **Captures** | Auto-extracts learnings from conversations (via plugins) | N/A |
| **Decays** | Yes — unused memories fade (ACT-R model) | No — code index reflects current state |
| **Timeline** | Episodes track what happened when (incidents, fixes, decisions) | Git log only |
| **Cross-tool** | Any MCP client (Claude Code, Cursor, Windsurf, OpenClaw, Hermes) | Typically tied to one tool |

While search is a core part of PLUR (finding the right engram to inject), the search targets are always engrams — not files, not code, not documents. PLUR's hybrid search (BM25 + embeddings + RRF) is optimized for short natural-language assertions, not source code.

## Packages

| Package | Description |
|---------|-------------|
| [`@plur-ai/core`](packages/core) | Engram engine — learn, recall, inject, search, decay |
| [`@plur-ai/mcp`](packages/mcp) | MCP server for Claude Code, Cursor, Windsurf |
| [`@plur-ai/claw`](packages/claw) | OpenClaw ContextEngine plugin |
| [`@plur-ai/cli`](packages/cli) | CLI — plur learn / recall / inject / status |
| [`@plur-ai/dsh`](packages/dsh) | DeepSeek Harness plugin — engrams in the prompt, no tool call |
| [`@plur-ai/migrate`](packages/migrate) | Store migrations, shipped with the release they migrate to |
| [`plur-hermes`](packages/hermes) | Hermes Agent plugin (Python, via CLI bridge) |
| [`plur-ai`](packages/python) | Python SDK — learn/recall/inject for LangChain, llama.cpp, scripts |
| [`plur-langchain`](packages/langchain) | LangChain BaseMemory + BaseChatMessageHistory adapter |

`packages/ui` is internal — the memory viewer's pages, bundled into the CLI and
the DeepSeek Harness plugin rather than published. It is not on npm.

## Architecture

```
@plur-ai/core
├── engrams.ts           Engram CRUD + YAML persistence
├── episodes.ts          Episode capture + timeline queries
├── fts.ts               BM25 with IDF, TF saturation (k1/b), length normalization
├── embeddings.ts        BGE-small-en-v1.5, 384-dim, local ONNX
├── hybrid-search.ts     Reciprocal Rank Fusion
├── inject.ts            Context-aware selection + spreading activation
├── decay.ts             ACT-R activation decay
├── secrets.ts           Secret detection (API keys, passwords, tokens)
├── sync.ts              Git-based sync + file locking (O_EXCL)
├── storage.ts           Path detection + YAML I/O
└── storage-indexed.ts   Optional SQLite read index

@plur-ai/mcp          Wraps core as MCP tools
@plur-ai/claw          OpenClaw ContextEngine hooks (assemble/compact/afterTurn)
plur-hermes            Python plugin for Hermes Agent (auto inject/learn)
plur-ai                Python SDK — direct learn/recall/inject for scripts and frameworks
```

### Storage

Everything is plain YAML. Open it, read it, edit it.

```
~/.plur/
├── engrams.yaml     # learned knowledge (source of truth)
├── episodes.yaml    # session timeline
├── config.yaml      # settings
└── engrams.db       # optional SQLite read index (auto-generated)
```

`PLUR_PATH` overrides the default location.

Indexing is on by default (`index: true`) and the backend is chosen from the
size of your store, so there is normally nothing to configure:

| Store size | Backend | What answers a query |
|---|---|---|
| under 5,000 engrams | `yaml` | in-memory BM25 + exact cosine |
| 5,000 and up | `pglite` | embedded Postgres + pgvector |
| 50,000 and up | `postgres` | a Postgres server you point it at — BM25 in SQL; semantic recall scores in memory (see below) |

YAML stays the source of truth in every tier except `postgres` (ADR-0001,
ADR-0005) — the index is a cache that rebuilds automatically, and you can delete
it anytime. Set `backend:` in `config.yaml` to pin a tier explicitly.

One caveat on the `postgres` tier, stated here because it is this table's
headline row: **core does not write embeddings to a Postgres primary store**
(ADR-0005 amendment). Keyword/BM25 recall runs in SQL, but `engram_embeddings`
stays empty unless your deployment populates it, so semantic and hybrid recall
fall back to loading engrams and scoring in memory — correct results, at the
O(N) cost this tier otherwise avoids. The adapter says so once at schema init;
`vectorIndex: 'exact'` acknowledges and silences it.

`sqlite` (`engrams.db`, via `better-sqlite3`) is the legacy index and is no
longer selected automatically.

## Requirements

- **Node.js 18+**
- **2GB RAM minimum** — the embedding model (ONNX runtime) needs ~1GB for installation. On servers with less RAM, embeddings are skipped and search falls back to BM25 keyword matching.

## Development

```bash
git clone https://github.com/plur-ai/plur.git
cd plur
pnpm install && pnpm build && pnpm test
```

~3500 tests across ~200 files. `pnpm test:watch` for development.

## Contributing

- **Bug reports** — issue with reproduction steps
- **Feature requests** — issue describing the use case
- **Code** — fork, branch, PR. Tests required.
- **Integrations** — build PLUR support for other tools

Before submitting: `pnpm test` passes, `pnpm build` succeeds, no new external deps in core without discussion.

Conventions: TypeScript, Zod validation, Vitest, no external APIs in core, YAML storage, zero-cost search by default.

## License

Apache-2.0
