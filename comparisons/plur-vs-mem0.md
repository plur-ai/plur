# PLUR vs mem0

**Choose mem0 for a hosted memory API with the broadest integrations. Choose PLUR to own your memory — an open, local, portable format across every tool.**

> **Bottom line:** mem0 if you want a fully-hosted service and the biggest integration ecosystem; **PLUR if you want to own the memory** — an open engram format, fully local, shared across tools over MCP.

## What each is best at

- **mem0** — the market leader: LLM-native dedup, graph memory, 20+ vector stores, an OpenMemory MCP server, and the biggest ecosystem and adoption in the space. If you want a hosted platform with integrations out of the box, mem0 is the safe pick.
- **PLUR** — memory you *own*: a typed, open YAML **engram** format (published spec, `plur.ai/spec.html`) that runs fully local — no cloud, no phone-home — and is shared across tools over MCP. Right-to-erasure is a real file delete (`plur_forget`).

## Where they differ (that matters)

- **Open format vs internal store.** mem0 is open-*code*, but memory lives in its internal representation. PLUR's memory is an open, portable *format* you can read, diff in git, and move to another tool.
- **Local-first vs cloud-default.** mem0 is Apache-2.0 and self-hostable, but its promoted path is the hosted platform. PLUR's default posture is fully local.
- **Portable packs.** PLUR bundles and hands off team memory as files (knowledge packs); mem0 has no pack primitive.
- **Pre-built integrations — mem0 leads today.** 20+ stores/DBs out of the box. PLUR scales on Postgres + pgvector + Apache AGE at enterprise, but ships fewer turnkey adapters.

## Recall — table stakes, not the deciding factor

Both are competitive; quality is table stakes. PLUR reaches **97.6% R@5 on LongMemEval-S**, fully local. We don't run a head-to-head scores race — the decision is ownership.
*(LongMemEval-S · n=500 · chunk · canonical-doc; R@5 = evidence in the top-5, not answer accuracy; measured on our own plur-bench harness, public with our paper.)*

## Choose mem0 if
you want a fully-hosted service with nothing running on your own infrastructure, the broadest set of pre-built integrations, or proven large-scale adoption right now.

## Choose PLUR if
you need data sovereignty (regulated / on-prem / air-gapped), one memory shared across multiple tools you own, or an open portable format you're not locked into.

## Install PLUR

```
npx @plur-ai/mcp init      # Claude Code / Cursor / Windsurf (any MCP client)
openclaw plugins install @plur-ai/claw && openclaw gateway --force   # OpenClaw
pip install plur-hermes    # Hermes Agent (Python)
```

Engrams are stored locally as files under `~/.plur/` — your files, your infrastructure. Connect over MCP from Claude Code, Cursor, Windsurf, OpenClaw, or Hermes.

## FAQ

**mem0 vs PLUR — which should I use?** mem0 for a hosted API and integration breadth; PLUR to own the memory as an open, local, portable format across tools.

**Is mem0 or PLUR better for on-prem / sovereign data?** PLUR — it runs fully local with no phone-home and stores memory as files you control. mem0 is self-hostable too, but its default is the hosted platform.
