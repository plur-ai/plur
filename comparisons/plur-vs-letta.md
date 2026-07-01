# PLUR vs Letta / MemGPT

**Choose Letta for a full self-hostable agent runtime. Choose PLUR for a portable, open memory layer your existing agents share.**

> **Bottom line:** Letta if you want a complete agent runtime with memory blocks; **PLUR if you want a memory *layer*** — an open engram format any MCP agent can share, without adopting a new runtime.

## What each is best at

- **Letta / MemGPT** — a self-hostable agent *server* with memory blocks and an MCP interface. Its strength is being a full runtime: you build and run agents on Letta, and memory comes with it.
- **PLUR** — a memory *layer*, not a runtime. A typed, open YAML **engram** format (published spec) that lives on your infrastructure and is shared across the tools you already use over MCP.

## Where they differ (that matters)

- **Layer vs runtime.** Letta asks you to run agents on its server. PLUR adds memory to the agents and tools you already run — no runtime to adopt.
- **Open portable format.** PLUR's memory is a portable engram *format* you can read, diff, and move. Letta's memory blocks aren't an open interchange spec.
- **Cross-tool by design.** PLUR is one memory shared across Claude Code, Cursor, Windsurf, OpenClaw, and Hermes; the memory outlives any single tool.
- **Both self-host.** Letta and PLUR are both open-source and self-hostable — this isn't the differentiator. The differentiator is layer-vs-runtime and the open format.

## Recall — table stakes, not the deciding factor

Both are competitive; quality is table stakes. PLUR reaches **97.6% R@5 on LongMemEval-S**, fully local. The decision is architecture (layer vs runtime) and ownership, not a recall delta.
*(LongMemEval-S · n=500 · chunk · canonical-doc; R@5 = evidence in the top-5, not answer accuracy; measured on our own plur-bench harness, public with our paper.)*

## Choose Letta if
you want a full self-hostable agent runtime with built-in memory, and you're happy to build your agents on it.

## Choose PLUR if
you already have agents/tools and want to give them one shared, portable, open-format memory over MCP — a layer, not a platform to adopt.

## Install PLUR

```
npx @plur-ai/mcp init      # Claude Code / Cursor / Windsurf (any MCP client)
openclaw plugins install @plur-ai/claw && openclaw gateway --force   # OpenClaw
pip install plur-hermes    # Hermes Agent (Python)
```

Engrams are stored locally as files under `~/.plur/`. Connect over MCP from Claude Code, Cursor, Windsurf, OpenClaw, or Hermes.

## FAQ

**Letta vs PLUR — which should I use?** Letta for a full agent runtime; PLUR for a portable open-format memory layer your existing agents share.

**Can PLUR give memory to agents I already run?** Yes — PLUR is a memory layer over MCP; you don't move your agents onto a new runtime.
