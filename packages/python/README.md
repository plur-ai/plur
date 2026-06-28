# plur-ai

**Local-first shared memory for AI agents — as a Python SDK.**

[PLUR](https://plur.ai) gives an agent persistent memory: corrections,
preferences, and conventions that survive across sessions, tools, and machines,
stored as plain YAML on your disk with zero-cost local search. `plur-ai` is the
Pythonic way to use it from any Python agent stack.

```bash
pip install plur-ai
```

## Quickstart

```python
from plur_ai import Plur

plur = Plur()  # uses ~/.plur (override with Plur(path=...))

plur.learn("api-service uses REST, not GraphQL", type="architectural", domain="dev/arch")
plur.learn("deploy with blue-green; never in-place restart prod", type="architectural")

for hit in plur.recall("which API style do we use", limit=5):
    print(hit["statement"])

print(plur.status())   # {'engram_count': 2, ...}
```

`learn`, `recall`, `inject`, and `status` map onto the same operations the PLUR
MCP server exposes to Claude Code and Cursor — so memory written from Python is
the *same* store your other agents read.

## Requirements

`plur-ai` is a thin wrapper over the [`@plur-ai/cli`](https://www.npmjs.com/package/@plur-ai/cli)
(Node). Install it once:

```bash
npm install -g @plur-ai/cli
```

If the CLI isn't on `PATH`, the SDK falls back to `npx @plur-ai/cli`. You can
also point at an explicit build with `Plur(binary=...)` or the `PLUR_CLI` env var.

## How it compares to `plur-hermes`

Both are Python and both bridge to the same CLI/store — the difference is audience:

| | `plur-ai` | `plur-hermes` |
|---|-----------|---------------|
| **What** | General-purpose memory SDK | [Hermes Agent](https://github.com/) plugin |
| **Use it for** | LangChain, llama.cpp, custom agent loops, scripts | Drop-in memory for a Hermes agent |
| **Surface** | A `Plur` client you call directly | Auto-registers via Hermes' plugin system |
| **Control** | You decide when to learn / recall / inject | Automatic inject-before-call, learn-after-response |

Reach for `plur-ai` when you're wiring memory into your own Python stack; reach
for `plur-hermes` when you're running Hermes and want it to "just work."

## Integrations

Runnable patterns in [`examples/`](examples/):

- [`langchain_memory.py`](examples/langchain_memory.py) — inject PLUR memory into a LangChain prompt
- [`llamacpp_memory.py`](examples/llamacpp_memory.py) — prepend recalled memory to a llama.cpp completion

## API

| Method | Returns |
|--------|---------|
| `learn(statement, *, type, scope, domain, tags, source, rationale)` | the created engram (dict) |
| `recall(query, *, limit)` | list of matching engrams |
| `inject(task, *, budget)` | `{directives, constraints, consider, count, tokens_used}` |
| `status()` | `{engram_count, episode_count, storage_root, ...}` |

## License

Apache-2.0
