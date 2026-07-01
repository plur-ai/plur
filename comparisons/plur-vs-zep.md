# PLUR vs Zep / Graphiti

**Choose Zep/Graphiti for a mature temporal knowledge graph. Choose PLUR for an open, owned engram format that spans tools — fully local.**

> **Bottom line:** Zep if a temporal knowledge graph is your core data model; **PLUR if you want to own the memory** as an open, portable format, local-first and shared across tools.

## What each is best at

- **Zep / Graphiti** — a temporal knowledge graph for memory (Zep hosted, Graphiti open-source, with a Graphiti MCP server). Its strength is first-class, mature temporal-graph modeling with time-based invalidation.
- **PLUR** — memory you *own*: a typed, open YAML **engram** format (published spec) that runs fully local and is shared across tools over MCP, with editing and ACT-R-style decay.

## Where they differ (that matters)

- **Open format vs graph store.** PLUR's memory is a portable engram *format* you read, diff, and move. Zep's temporal KG isn't an open interchange spec.
- **Local-first, sovereign.** PLUR runs with no cloud and no phone-home; erasure is a real file delete. Zep's managed product is cloud; Graphiti can be self-hosted.
- **Forgetting — two approaches.** Zep does time-based graph invalidation; PLUR uses ACT-R-style activation decay. Neither uniquely wins — pick the model that fits.
- **Graph depth — Zep leads.** If a rich temporal graph *is* the point, Zep is stronger today; PLUR's graph is lighter, with a graph-DB backend on the roadmap.

## Recall — table stakes, not the deciding factor

Both are competitive; quality is table stakes. PLUR reaches **97.6% R@5 on LongMemEval-S**, fully local. (Zep's LOCOMO numbers are publicly disputed depending on the harness — we don't run a head-to-head.)
*(LongMemEval-S · n=500 · chunk · canonical-doc; R@5 = evidence in the top-5, not answer accuracy; measured on our own plur-bench harness, public with our paper.)*

## Choose Zep if
a mature temporal knowledge graph is your core model, or you want a managed graph-memory service today.

## Choose PLUR if
you want an open, owned engram format, local-first operation, and one memory shared across the tools you already use.

## Install PLUR

```
npx @plur-ai/mcp init      # Claude Code / Cursor / Windsurf (any MCP client)
openclaw plugins install @plur-ai/claw && openclaw gateway --force   # OpenClaw
pip install plur-hermes    # Hermes Agent (Python)
```

Engrams are stored locally as files under `~/.plur/`. Connect over MCP from Claude Code, Cursor, Windsurf, OpenClaw, or Hermes.

## FAQ

**Zep vs PLUR — which should I use?** Zep for temporal-graph modeling; PLUR for an open, owned, local engram format that spans tools.

**Which agent memory is local-first / sovereign — Zep or PLUR?** PLUR — fully local, no phone-home, memory as files you control. Graphiti is self-hostable; managed Zep is cloud.
