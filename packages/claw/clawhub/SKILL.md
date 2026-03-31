---
name: plur-memory
description: "Persistent learning for AI agents. Open engram format. Your agent learns from corrections, remembers across sessions, and transfers knowledge across domains."
version: 0.1.0
---

# PLUR Memory

Your OpenClaw can now learn. Permanently.

Install the plugin first: `openclaw plugins install @plur-ai/claw`

Or tell your OpenClaw: `go to plur.ai and install memory`

## How It Works

Corrections, preferences, and patterns are stored as **engrams** - small YAML files on your machine. An open format any tool can read. Engrams strengthen with use and decay when irrelevant, modeled on how human memory actually works.

Every session, relevant engrams are injected automatically. Your agent remembers what you taught it yesterday, last week, last month.

## Memory Lifecycle

- **Automatic injection** runs every session start - relevant engrams appear in your context
- When you discover something worth remembering - call `plur_learn` with a clear statement
- When corrected by the user - call `plur_learn` immediately with the correction
- When an injected engram was helpful - call `plur_feedback` with signal "positive"
- When an injected engram was wrong or stale - call `plur_feedback` with signal "negative"
- When a memory is no longer true - call `plur_forget` with the engram ID

## What to Learn

- Corrections: "The API returns snake_case, not camelCase"
- Preferences: "User prefers TypeScript over JavaScript"
- Patterns: "This codebase uses repository pattern for data access"
- Decisions: "We chose PostgreSQL for ACID compliance"
- Conventions: "Always run lint before committing"

## What NOT to Learn

- Trivial facts ("the user said hello")
- Things already in the codebase (file paths, function names - those change)
- Session-specific state ("we're working on X right now")

## Meta-Engrams (Experimental)

With enough engrams, PLUR extracts meta-engrams - patterns that transfer across domains. You teach coding conventions in one project, deployment rules in another - PLUR spots the shared principle. Transfer of knowledge.

Run `plur_extract_meta` periodically to distill cross-domain principles.

## Shared Memory

The memory is shared across tools. Same `~/.plur/` files - OpenClaw, Claude Code, Cursor, Hermes, CLI. What one agent learns, every agent knows.

Across devices: `plur sync`

## Links

- Website: https://plur.ai
- Engram Spec: https://plur.ai/spec
- Benchmarks: https://plur.ai/benchmark
- GitHub: https://github.com/plur-ai/plur
- npm: https://npmjs.com/package/@plur-ai/claw
