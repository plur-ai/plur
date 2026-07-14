---
name: plur-memory
description: "Your memory stays on your machine. No cloud, no tracking, no API key. PLUR makes your OpenClaw remember — and shares that memory with every other tool you use."
version: 0.10.0
---

# PLUR Memory

Most memory plugins send your context to a cloud server. PLUR doesn't.

Your memory lives on your disk — plain files you can read, edit, move, and back up. Zero cloud routing. Zero API keys. Zero cost.

**Install in one command:**

```
openclaw plugins install @plur-ai/claw
```

Or tell your OpenClaw: `go to plur.ai and install memory`

## What happens next

Every correction you make becomes a permanent engram. Every preference gets remembered. The next time you open a session, PLUR injects what's relevant — automatically, before you type a word.

## One memory, every tool

Correct something in OpenClaw — your Claude Code picks it up. Teach a pattern in Cursor — OpenClaw already knows. Memory moves with you across every MCP-compatible tool you use.

## Features

- Learns from corrections and preferences as you work — no manual notes
- Injects relevant context at session start — no re-explaining from scratch
- Memory strengthens with use, fades when stale — modeled on human memory
- Works across Claude Code, Cursor, Copilot, and any MCP-compatible tool
- No cloud, no API key, no cost — ever

## Benchmarks (reported, v0.2.1 baseline)

- 86.7% overall on LongMemEval — beats Supermemory (81.6%) on the same benchmark
- 89% agent task win rate — Haiku with PLUR outperformed Opus without it
- 100% convention adherence
- Full methodology: https://plur.ai/benchmark.html

## Open source. Local-first. Private. Free.

Apache-2.0. Your data never leaves your machine.

## Requirements

- OpenClaw >= 2026.3.7
- Node.js >= 18

## Links

- Website: https://plur.ai
- GitHub: https://github.com/plur-ai/plur
- npm: https://npmjs.com/package/@plur-ai/claw
- Benchmarks: https://plur.ai/benchmark.html

**Author:** PLUR (info@plur.ai)
