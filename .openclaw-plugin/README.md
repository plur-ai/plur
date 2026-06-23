# PLUR for OpenClaw

Shared memory across your OpenClaw agents. PLUR plugs into the OpenClaw
ContextEngine — auto-injecting relevant memories on session start and
auto-extracting learnings from conversations. Local-first, no cloud required.

## Install

```bash
openclaw plugins install @plur-ai/claw
openclaw config set plur.enabled true
```

That's it. PLUR works in the background from here — corrections accumulate
automatically, no workflow changes needed.

## Configuration

The plugin exposes `path`, `auto_learn`, `auto_capture`, and `injection_budget`
options. See the full manifest in
[`packages/claw/openclaw.plugin.json`](../packages/claw/openclaw.plugin.json).

Full docs → [plur.ai](https://plur.ai)
