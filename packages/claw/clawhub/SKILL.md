---
name: plur-memory
description: "Engram exchange + local-first memory for OpenClaw. No cloud routing, no API keys. Your corrections become shareable knowledge packs."
version: 0.15.0
---

# PLUR Memory — Engram Exchange Layer for OpenClaw

Every correction you make is permanent knowledge — **stored on your machine, owned by you, shareable as packs**.

Most memory plugins send your context to a cloud server. PLUR doesn't.

Your memory lives on your disk — plain YAML files you can read, edit, move, and back up. Zero cloud routing. Zero API keys. Zero cost.

## What makes PLUR different

**Engram Exchange.** Every correction becomes an atomic engram — a single fact with a source and context. You don't learn "systems design"—you learn the three-step pattern your team discovered last Tuesday. Engrams are **packs**: curated collections you can share, install, sell.

**Local-first data control.** Your team's knowledge stays on your machine. No external calls. No vendor lock-in. No compliance friction. When you sync across machines, it's Git-based — your repo, your rules.

**Works everywhere.** Memory syncs across Claude Code, Cursor (beta), OpenClaw, and any MCP-compatible tool. Correct something in OpenClaw — your Claude Code picks it up.

## Install in one command

```
openclaw plugins install @plur-ai/claw
```

Or tell your OpenClaw: `go to plur.ai and install memory`

## What happens next

Every correction you make becomes a permanent engram. Every preference gets remembered. Teach a pattern in OpenClaw — it's immediately available to share as a pack.

The next time you open a session, PLUR injects what's relevant — automatically, before you type a word. No manual prompting. No context re-explaining.

## Features

- **Learns from corrections** — capture mistakes and patterns as you work, no manual notes
- **Pack ecosystem** — curate engrams into packs, share them with your team or sell them
- **Injects relevant context** at session start — no re-explaining from scratch
- **Memory strengthens with use** — human activation model, fades when stale
- **Works across tools** — Claude Code, Cursor (beta), OpenClaw, any MCP-compatible tool
- **No cloud, no API key, no cost** — by default. Enterprise: optional self-hosted remote store
- **Transparent format** — YAML on disk, readable and auditable

## How Packs Work

A pack is a collection of engrams curated for a specific domain. Examples:

- **Team patterns** — your company's 12-step troubleshooting protocol
- **Coding conventions** — your project's error handling standards
- **Expert knowledge** — domain-specific insights from your team
- **Domain teaching packs** — shareable knowledge about a topic or technology

Install a pack once, it injects automatically. If the pack updates, you sync new engrams. If an engram conflicts with your own, yours wins.

Packs can be free (GitHub repos), paid (marketplace), or private (internal use only).

## Benchmarks

- **Retrieval** (LongMemEval R@5): **76.7%** out-of-the-box · **97.0%** with opt-in reranker — [full methodology](https://plur.ai/benchmark.html)
- **Agent tasks**: 89% win rate — Haiku + PLUR outperforms Opus *without* memory
- **House rules**: 12–0 across Haiku, Sonnet, Opus

## Open source. Local-first. Private. Free.

Apache-2.0. Your data never leaves your machine.

## Requirements

- OpenClaw >= 2026.3.7
- Node.js >= 18

## Why not cloud memory?

Supermemory and similar tools route your context through their cloud. PLUR is different:

| Aspect | PLUR | Cloud Alternatives |
|--------|------|-------------------|
| **Data location** | Your disk | Vendor's servers |
| **API keys** | None required | Required |
| **Cost** | Free (local) | Per-token pricing |
| **Sync** | Git-based (your control) | Proprietary cloud sync |
| **Sharing** | Shareable packs (your choice) | Account-based sharing |
| **Compliance** | No external calls | Subject to vendor compliance |

## Links

- Website: https://plur.ai
- GitHub: https://github.com/plur-ai/plur
- npm: https://npmjs.com/package/@plur-ai/claw
- Benchmarks: https://plur.ai/benchmark.html
- Pack Registry (beta): https://packs.plur.ai

**Author:** PLUR (info@plur.ai)
