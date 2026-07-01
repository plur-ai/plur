# PLUR vs Cognee

**Choose Cognee for an open, self-hostable graph+vector pipeline. Choose PLUR for a portable engram format you own and share as packs.**

> **Bottom line:** Cognee if you want an ECL graph+vector memory pipeline; **PLUR if you want to own the memory** as an open, portable format with shareable knowledge packs.

## What each is best at

- **Cognee** — an open, self-hostable ECL (extract-cognify-load) graph+vector memory pipeline, EU-funded, with an official `cognee-mcp` server. Its strength is a solid graph pipeline you can run yourself.
- **PLUR** — memory you *own*: a typed, open YAML **engram** format (published spec) that runs fully local, is shared across tools over MCP, and bundles into portable knowledge packs.

## Where they differ (that matters)

- **Both are open and self-hostable** — that's not the differentiator. The difference is *what the memory is*.
- **Portable format vs graph pipeline.** PLUR's memory is a portable engram *format* (read, diff, move); Cognee is a graph+vector store, not an open interchange spec.
- **Knowledge packs.** PLUR bundles and shares team memory as files; Cognee has no pack primitive.
- **Graph depth — Cognee leads.** If a graph pipeline *is* the point, Cognee is stronger today; PLUR's graph is lighter (graph-DB on the roadmap).

## Recall — table stakes, not the deciding factor

Both are competitive; quality is table stakes. PLUR reaches **97.6% R@5 on LongMemEval-S**, fully local. The decision is the open portable format and packs, not a recall delta.
*(LongMemEval-S · n=500 · chunk · canonical-doc; R@5 = evidence in the top-5, not answer accuracy; measured on our own plur-bench harness, public with our paper.)*

## Choose Cognee if
you want an open, self-hostable graph+vector pipeline as your memory model.

## Choose PLUR if
you want a portable engram *format* you own, shareable knowledge packs, and one memory across the tools you already use.

## Install PLUR

```
npx @plur-ai/mcp init      # Claude Code / Cursor / Windsurf (any MCP client)
openclaw plugins install @plur-ai/claw && openclaw gateway --force   # OpenClaw
pip install plur-hermes    # Hermes Agent (Python)
```

Engrams are stored locally as files under `~/.plur/`. Connect over MCP from Claude Code, Cursor, Windsurf, OpenClaw, or Hermes.

## FAQ

**Cognee vs PLUR — which should I use?** Cognee for a graph+vector pipeline; PLUR for a portable, owned engram format with shareable packs.

**Both are open-source and EU-aligned — what's the real difference?** What the memory *is*: Cognee is a graph store; PLUR is an open portable format you can read, diff, move, and share as packs.
