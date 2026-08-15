# @plur-ai/dsh

**Persistent memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Your agent corrected on Monday remembers on Tuesday.**

English | [中文](README.zh.md)

Exposing memory as a tool is the common pattern — the model still has to decide
to call it. This one puts the memories themselves in the prompt.

```sh
dsh plugin --profile web add @plur-ai/dsh
```

That's it. Restart `dsh` and your agent has memory.

## How it works

PLUR registers a system-prompt section that DeepSeek Harness re-renders on every
request. Relevant memories are simply *there*, in front of the model, with no
tool call to decide on.

Recall runs off the turn path, so the block lands from the second assembly of a
session onward. A turn is never delayed waiting on the memory store.

| | Cue-based memory | `@plur-ai/dsh` |
|---|---|---|
| Model must call a tool to recall | Yes | **No** |
| Extra round trip per recall | Yes | **No** |
| Works when the model ignores the hint | No | **Yes** |
| Tool schemas billed every request | 13 | **5** |

The distinction matters because a cue is a gamble. If the model doesn't take the
hint, the memory may as well not exist — and "why didn't it remember?" is the
complaint that kills trust in a memory system. Injected content can't be ignored.

Nothing accumulates: because memory is a rendered prompt section rather than a
message appended to the conversation, a hundred-turn session costs the same as a
one-turn session.

## Why PLUR

Search is fully local — BM25 + BGE embeddings fused with Reciprocal Rank Fusion.
Zero API calls, zero cloud, works offline. Storage is plain YAML at `~/.plur`
that you can read, edit, and delete.

We publish our retrieval numbers, measured on LongMemEval:

On a 30-question sanity subset of LongMemEval-S, PLUR's retrieval scores
**76.7% Hit@5** in the configuration this plugin ships — hybrid BM25 + BGE
embeddings, no reranker (core v0.9.13, 2026-06-27).

n=30 is a smoke test, not a leaderboard: one question is worth 3.3 points. The
reproducible harness and the raw runs are in
[plur-bench](https://github.com/plur-ai/plur-bench).

## Tools

Five, deliberately — dsh bills every registered tool's schema on every request.

| Tool | What it does |
|---|---|
| `plur_recall` | Targeted lookup beyond what's already injected |
| `plur_learn` | Store a correction, preference, or durable fact |
| `plur_forget` | Retire a memory that's wrong or out of date |
| `plur_feedback` | Rate a memory — trains what surfaces next time |
| `plur_status` | Health and this session's memory activity |

Want the full ~40-tool surface? Use [`@plur-ai/mcp`](https://www.npmjs.com/package/@plur-ai/mcp)
alongside or instead.

## Commands

Both dispatch without spending a model turn.

| Command | What it does |
|---|---|
| `/plur` | Memory status and this session's activity |
| `/plur-memory` | Opens the memory viewer in your browser |

## The memory viewer

`/plur-memory` starts a local page listing every engram — what was learned,
what actually gets recalled, and how often. It binds loopback only, serves
read-only, and returns a URL:

```
PLUR memory viewer: http://127.0.0.1:53119/
(local to this machine, read-only)
```

The same page `plur ui` serves, in English and 中文. It stops when the plugin
unloads.

Why a command and not a tab: dsh renders its UI as a React client assembled
over a typed slot registry, so a native tab means shipping a browser bundle
bound to that registry's pre-1.0 internals. A URL costs nothing and breaks on
nobody's upgrade.

## What leaves your machine

PLUR stores everything locally in `~/.plur` and searches it locally. But injected
memories become part of the prompt your agent sends to **your configured model
provider** — for a default DeepSeek Harness install, that is DeepSeek's hosted
API at `api.deepseek.com`.

**Writes** go to the scope belonging to the workspace you are in — your
project's own `.plur.yaml` scope if it declares one, otherwise
`project:<directory name>`. Nothing this plugin learns is written to `global`.

**Reads** are that same scope *plus your global engrams*. That is PLUR's own
model, not something this plugin adds: `global` is a personal scope, and
personal scopes deliberately pass every project-scoped filter, so a scoped
recall includes them. If your global store holds things you would rather a
coding harness never see, move them to a project scope or set `scope`
explicitly — `plur ui` shows you what is in there.

Two details worth knowing:

- Scope membership is exact, with no hierarchy expansion. A session scoped to
  `project:acme` does not read `project:acme:api`. This plugin's own derivation
  is flat so it never creates those, but a store populated through the CLI or
  MCP with hierarchical child scopes will not surface them here.
- A workspace's `.plur.yaml` is trusted as written. A repository you clone can
  declare a scope, and this plugin will use it for both reads and writes — the
  same as `@plur-ai/core` itself. Check it the way you would check any other
  file you are about to run.

A workspace's own `.plur.yaml` scope wins. The `scope` setting below applies
when the workspace declares none — set it, or turn injection off entirely:

```yaml
# $DSH_HOME/settings.yaml
plur:
  scope: project:acme     # optional — omit to derive per workspace
  injectionMode: content  # or: off
```

## Configuration

All settings live under the `plur` namespace in `$DSH_HOME/settings.yaml`
(usually `~/.dsh/settings.yaml`).

| Setting | Default | Meaning |
|---|---|---|
| `path` | `~/.plur` | Store location |
| `scope` | derived | Which memory scope this harness may read and write. Omitted, it derives per workspace |
| `injectionMode` | `content` | `content` injects memories; `off` disables injection |
| `injectionBudget` | `2000` | Approximate token ceiling for the injected block |
| `refreshIntervalMs` | `0` | Floor between recalls; `0` means once per turn |
| `autoLearn` | `true` | Detect corrections in your messages and store them |
| `autoCapture` | `true` | Record an episode summary at turn end |
| `timeoutMs` | `5000` | Hard bound on any single memory call |
| `viewerEnabled` | `true` | Register the `/plur-memory` command |
| `includeGlobal` | `true` | Whether global engrams accompany the workspace scope |

**Reranking** is configured through PLUR itself, not here: set the
`PLUR_RERANKER` environment variable. It runs in the harness's own process and
`bge-reranker-v2-m3` peaks around 2GB RSS, where a native OOM cannot be caught
by a JavaScript `try`/`catch` and would take your agent down with it. Leave it
unset for interactive use.
enable it for local batch work where a crash costs you nothing.

## When memory misbehaves

Run `/plur` or ask for `plur_status`. The counters tell you whether recall ran at
all, whether the block changed, and whether anything was swallowed:

```
scope: project:acme
injection: content
refresh_attempted: 12
blocks_written: 4
blocks_unchanged: 8
errors_swallowed: 0
```

`errors_swallowed > 0` means PLUR failed and the plugin degraded quietly — by
design, a memory failure never fails your turn.

## Also available for

Claude Code and Cursor (via MCP), OpenClaw, Hermes, LangChain, and a Python SDK.
Same engrams, same store, every tool you use.

## Links

- [plur.ai](https://plur.ai) · [docs.plur.ai](https://docs.plur.ai)
- [github.com/plur-ai/plur](https://github.com/plur-ai/plur)

Apache-2.0
