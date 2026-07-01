# PLUR vs Mastra

**Choose Mastra for memory built into its TypeScript agent framework. Choose PLUR when memory must outlive and cross frameworks.**

> **Bottom line:** Mastra if you're building inside its TS framework and want memory integrated there; **PLUR if memory must be framework-agnostic** — an open format shared across every tool over MCP.

## What each is best at

- **Mastra** — a TypeScript agent framework with observational memory built in. Its strength is developer experience *within* the framework: memory, workflows, and tools in one TS stack.
- **PLUR** — a memory *layer* independent of any framework: a typed, open YAML **engram** format (published spec) that runs fully local and is shared across tools over MCP.

## Where they differ (that matters)

- **Framework-bound vs framework-agnostic.** Mastra's memory lives inside Mastra (TS). PLUR's memory is separate and portable — it spans Claude Code, Cursor, Windsurf, OpenClaw, Hermes, and Mastra itself.
- **Open portable format.** PLUR's memory is an open engram *format* you own, read, and move; Mastra's memory is a framework feature, not an interchange spec.
- **Local-first, sovereign.** PLUR's default is fully local with no phone-home; erasure is a real file delete.

## Recall — table stakes, not the deciding factor

Both are competitive; quality is table stakes. PLUR reaches **97.6% R@5 on LongMemEval-S**, fully local. (Mastra's memory numbers are blog-level; we don't run a head-to-head.) The decision is portability, not a recall delta.
*(LongMemEval-S · n=500 · chunk · canonical-doc; R@5 = evidence in the top-5, not answer accuracy; measured on our own plur-bench harness, public with our paper.)*

## Choose Mastra if
you're building your agents in Mastra's TypeScript framework and want memory tightly integrated there.

## Choose PLUR if
your memory must be framework-agnostic and portable — shared across multiple tools, owned as an open format, running locally.

## Install PLUR

```
npx @plur-ai/mcp init      # Claude Code / Cursor / Windsurf (any MCP client)
openclaw plugins install @plur-ai/claw && openclaw gateway --force   # OpenClaw
pip install plur-hermes    # Hermes Agent (Python)
```

Engrams are stored locally as files under `~/.plur/`. Connect over MCP from Claude Code, Cursor, Windsurf, OpenClaw, or Hermes — including alongside Mastra.

## FAQ

**Mastra vs PLUR — which should I use?** Mastra for memory inside its TS framework; PLUR for a portable, open-format memory that crosses frameworks.

**Can I use PLUR with Mastra?** Yes — PLUR is a framework-agnostic memory layer over MCP; it complements rather than replaces a framework.
