# PLUR vs supermemory

**Choose supermemory for a clean hosted memory API. Choose PLUR when memory must be local, sovereign, and yours.**

> **Bottom line:** supermemory if you want a polished hosted API with zero setup; **PLUR if you must own the memory** — local, no phone-home, an open portable format.

## What each is best at

- **supermemory** — a clean hosted memory API with strong ensemble recall, and an open benchmark harness (`memorybench`). Its strength is a polished, zero-setup hosted service.
- **PLUR** — memory you *own*: a typed, open YAML **engram** format (published spec) that runs fully local — no cloud, no phone-home — and is shared across tools over MCP.

## Where they differ (that matters)

- **Local vs hosted.** supermemory is a hosted API; your memory sits on their service. PLUR runs on your own infrastructure by default, with no data egress.
- **Open format vs service.** PLUR's memory is an open, portable *format* you can read, diff, and move; supermemory's store is internal to the service.
- **Sovereignty.** With PLUR, erasure is a real file delete you can observe on disk; data never leaves your infrastructure in local mode.

## Recall — table stakes, not the deciding factor

Both are competitive; quality is table stakes. PLUR reaches **97.6% R@5 on LongMemEval-S**, fully local. We don't run a head-to-head scores race — the decision is where the memory lives and who owns it.
*(LongMemEval-S · n=500 · chunk · canonical-doc; R@5 = evidence in the top-5, not answer accuracy; measured on our own plur-bench harness, public with our paper.)*

## Choose supermemory if
you want a clean, fully-managed hosted API with strong recall and zero setup, and locality isn't a requirement.

## Choose PLUR if
data must stay on your infrastructure (regulated / on-prem / air-gapped), or you want an open portable format you own instead of a hosted service.

## Install PLUR

```
npx @plur-ai/mcp init      # Claude Code / Cursor / Windsurf (any MCP client)
openclaw plugins install @plur-ai/claw && openclaw gateway --force   # OpenClaw
pip install plur-hermes    # Hermes Agent (Python)
```

Engrams are stored locally as files under `~/.plur/` — your files, your infrastructure. Connect over MCP from Claude Code, Cursor, Windsurf, OpenClaw, or Hermes.

## FAQ

**supermemory vs PLUR — which should I use?** supermemory for a hosted API with zero setup; PLUR when memory must be local, sovereign, and owned as an open format.

**Which agent memory keeps data on my own infrastructure?** PLUR — fully local by default with no phone-home. supermemory is a hosted API.
