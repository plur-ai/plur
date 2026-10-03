# @plur-ai/mcp

Give your AI agent persistent memory. One line in your MCP config — corrections, preferences, and conventions persist across sessions. No workflow changes, no cloud, no API costs for search.

Part of [PLUR](https://plur.ai) — where, in our tool-routing and local-knowledge benchmark, **Haiku with memory outperformed Opus without it** at 10x less cost.

## Setup (30 seconds)

### Claude Code

One command — sets up storage, MCP config, and hooks:

```bash
npx @plur-ai/mcp init
```

Restart Claude Code. Done. Your agent now has persistent memory with automatic injection.

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "plur": { "command": "npx", "args": ["-y", "@plur-ai/mcp"] }
  }
}
```

### Windsurf / any MCP client

Same pattern — point it at `npx -y @plur-ai/mcp`.

That's it. Your agent now has memory. Use your tools as usual — corrections accumulate automatically.

## What happens

```
You correct your agent  →  engram created       →  YAML on your disk
Next session starts     →  relevant ones injected →  agent remembers
You rate the result     →  engram strengthens    →  quality improves
```

Knowledge is stored as **engrams** — small assertions that strengthen with use and decay when irrelevant. Search runs locally (BM25 + embeddings); with a PLUR Enterprise store configured, recall also makes one live, timeout-bounded call per relevant remote host and merges the team's engrams in — and tells you, per host, when that leg is degraded instead of failing silently. Without a remote store it is fully local, costs nothing, and works offline. [Benchmark methodology →](https://plur.ai/benchmark.html)

## Tools

By default (lean profile), your agent gets 14 tools. Everything else is reachable through `plur_admin`:

| Tool | What it does |
|------|-------------|
| `plur_session_start` | Start a session — injects relevant engrams for your task |
| `plur_learn` | Store a memory — correction, preference, convention, or decision |
| `plur_recall` | **Best default** — hybrid (BM25 + embeddings via RRF) by default; pass `mode:"keyword"` for BM25-only. Zero cost. |
| `plur_feedback` | Rate a memory — trains relevance over time |
| `plur_forget` | Retire a memory (history preserved) |
| `plur_session_end` | End a session — captures summary and new learnings |
| `plur_status` | System health |
| `plur_doctor` | Diagnose embedder, hybrid search, and remote-store auth |
| `plur_receipt` | Show why a memory was injected — the evidence behind a recall |
| `plur_packs_uninstall` | Remove an installed pack |
| `plur_tensions_purge` | Clear stale/resolved tensions |
| `plur_tensions` | List, scan, confirm, dismiss or resolve contradictions — resolve retires the losing memory, so it is a direct tool, never dispatched through `plur_admin` |
| `plur_validate_meta` | Test a meta-engram in a new domain — a third failure can retire it, so it is a direct tool too |
| `plur_admin` | Dispatch to any other tool: `{ action: "plur_packs_install", args: {...} }` |

Less commonly needed tools (`plur_recall_hybrid`, `plur_inject_hybrid`, `plur_learn_batch`, `plur_ingest`, `plur_sync`, `plur_packs_install`, `plur_packs_list`, `plur_capture`, `plur_timeline`, `plur_provenance`, and more) are all reachable via `plur_admin`. Set `PLUR_TOOL_PROFILE=full` to expose all 44 tools directly.

A `plur_*` name missing from `tools/list` means it moved behind the gateway, not that the server is down. `plur_admin { action: "help" }` returns every action with a one-line description and its argument schema; `plur_doctor` reports the same inventory as `tool_surface`.

## Folders where PLUR is off

Your folder map (`~/.plur/folders.yaml`, changed by `plur folders set` from a terminal) can turn PLUR off for a folder. The editor hooks already go silent there; the MCP server's memory tools do too.

**What is gated.** 33 tools — every tool that reads or writes engrams or episodes or returns their text: `plur_learn`, `plur_learn_batch`, `plur_recall`, `plur_recall_hybrid`, `plur_inject`, `plur_inject_hybrid`, `plur_session_start`, `plur_session_end`, `plur_capture`, `plur_timeline`, `plur_feedback`, `plur_pin`, `plur_forget`, `plur_ingest`, `plur_promote`, `plur_rescope`, `plur_episode_to_engram`, `plur_report_failure`, `plur_extract_meta`, `plur_meta_engrams`, `plur_validate_meta`, `plur_tensions`, `plur_tensions_purge`, `plur_similarity_search`, `plur_history`, `plur_provenance`, `plur_profile`, `plur_receipt`, `plur_packs_install`, `plur_packs_uninstall`, `plur_packs_export`, `plur_sync`, `plur_outbox` — called directly or through `plur_admin`. In an `off` folder they read and write no store, local or remote (no outbox row either), and return a normal, non-error answer:

```json
{ "success": true, "plur": "off", "folder": "/work/secret", "message": "PLUR is off for this folder … plur folders set /work/secret --on" }
```

The message names every folder-map entry that turns the folder off (a parent folder or a glob can), with the command for each.

**What is not gated.** The admin and diagnostic tools keep working: `plur_status`, `plur_doctor`, `plur_stores_list`, `plur_stores_add`, `plur_sync_status`, `plur_packs_list`, `plur_packs_discover`, `plur_packs_preview`, `plur_scopes_discover`, `plur_suggest_scope`, `plur_session_scope`. Some of them still read stores — status, doctor and stores_list load them to count or probe them, and doctor runs a recall probe. What they can return: counts, health and configuration; A store that cannot be parsed is reported by the error's first line only (what went wrong, line and column) — in `plur_status` and in the error any tool returns — never by the file's lines. One exception: `plur_packs_preview` previews any pack directory the agent names, including an installed pack under your PLUR home, and then returns that pack's statements. Server startup is not gated yet: starting the server in an `off` folder can still register a `.plur/` store found there ([#1523](https://github.com/plur-ai/plur/issues/1523)).

**Which folder.** The editor's workspace: each root the client lists over MCP `roots/list`, plus the folder the server was started in. If any of them is `off`, the memory tools are off. The folder map is read on every call, so a change takes effect on the next one. Calls made while the roots are being fetched wait for them. If fetching them fails or times out, or a root does not resolve to a folder on this machine (`file://otherhost/…`, an encoded slash), that call does nothing (it answers `"reason": "workspace-unknown"`, not an error) and the next call asks again; it never falls back to the start folder alone. If the client's roots keep failing, memory stays off until they work. The roots answer is cached, and shared between calls made at the same time, only when the client declares `roots.listChanged`; otherwise every call sends its own roots request. A client that declares no roots capability at all, and was started outside the workspace, cannot be checked against it.

**A broken folder map fails safe.** If `folders.yaml` exists but cannot be read or parsed — including a dangling symlink, a symlink loop, an empty or comments-only file, and an unknown top-level key such as a misspelled `folder:` — the gated tools do nothing and answer with `"reason": "folder-map-unreadable"`, naming the file, the line and column, and the problem in plain words — quoting at most the key on that line, never a value (#1526). A misspelled `plur:` or `path:` key (`plru:`, `pth:`) counts as broken too. When `plur folders repair` can fix it, the answer carries `repair_summary` (what the repair changes, to show the user first) and `repair_command` (`plur folders repair --yes`, with `--path` for a non-default store) and tells the agent to run it only after the user agrees; otherwise it says the line must be fixed by hand. A repair adds no `on` to the map; folders with their own trusted `.plur.yaml` or project MCP config are on again, as before the map broke. `plur_status` and `plur_doctor` report the same problem as `folder_map` (and `plur_doctor` fails its `folder map` check). No `folders.yaml` at all (nothing at that path) means no decisions yet: every folder is undecided and gets the question below. A broken map offers no folder-question command and issues no nonce (only the repair command, when the repair can fix it). On first read, an old `trust.yaml` is imported into a new `folders.yaml` (a one-time core migration); otherwise the server never writes the map.

**An undecided folder gets the folder question** ([#1525](https://github.com/plur-ai/plur/issues/1525)). In a folder you have not decided about (folder map `ask`: no entry and no project marker, or a repo `.plur.yaml` asking for settings you have not trusted), the gated tools read and write no memory and answer, without an error, with the same question the editor hooks ask:

```json
{ "success": true, "plur": "ask", "folder": "/work/app", "question": "[PLUR Memory — no decision for this folder yet …] …",
  "answers": [
    { "label": "Yes, with the team scope group:acme/eng", "command": "plur folders set /work/app --scope group:acme/eng --nonce … --session mcp-…" },
    { "label": "Yes, without a team scope", "command": "plur folders set /work/app --on --nonce … --session mcp-…" },
    { "label": "Not now", "command": "plur folders set /work/app --not-now --nonce … --session mcp-…" },
    { "label": "Never here", "command": "plur folders set /work/app --off --nonce … --session mcp-…" } ] }
```

The agent asks you and runs the command for your answer (or you run it in a terminal). Each command carries its own single-use nonce, bound to that folder, that answer and this MCP session: a command from another session, or one that drops `--session`, is refused. Every memory call returns the same question, with the same nonces, until you answer; the next call after an answer follows it. **Yes** turns memory on, and the answer's team scope becomes this session's default write scope: an unscoped `plur_learn` or `plur_learn_batch` goes there, with or without `plur_session_start` (which also uses the folder map's scope for its default when you pass none). An explicit scope still wins. With several workspace folders, a folder scope is used only when every folder has the same one. **Never here** turns it off. **Not now** writes nothing to the folder map: memory stays off for the rest of this MCP session, without the question; the folder stays undecided, so the next session asks again. The server never writes the map itself. The session's unanswered nonces are deleted as soon as the session closes (stdin ends, or SIGTERM / SIGINT); the server then exits once the tool calls already running have answered (after stdin ends, however long they take; on a signal, within 2 s); a server killed outright leaves its nonce file, which the next server removes once the nonces have expired (24 h). Precedence across the workspace folders is off, then ask, then on. `off` is checked on every workspace folder, the server's start folder included. The question is never asked about your home folder, a filesystem root or a folder above home, whether it is a root the client sends or the start folder: a yes or a never-here there would cover every folder under it, so memory there runs as before. Otherwise it is asked about the client's roots when it sends any — the start folder is wherever the client happened to launch the server — and, when it sends none (or only such folders), about the start folder. "Not now" stops the question, not the other answers: the yes and never-here commands of the same question keep working for that session, as with the editor hooks.

## Sync across machines

Your agent can sync memory to any git remote:

```
Agent: plur_sync({ remote: "git@github.com:you/plur-memory.git" })
→ "Initialized and pushed."

# On another machine, same remote:
Agent: plur_sync()
→ "Synced. Pulled 12 remote commits."
```

Works with GitHub, GitLab, Gitea, any git host. Your data, your repo.

## Configuration

Custom storage path:

```json
{
  "mcpServers": {
    "plur": {
      "command": "npx",
      "args": ["-y", "@plur-ai/mcp"],
      "env": { "PLUR_PATH": "/path/to/storage" }
    }
  }
}
```

Default: `~/.plur/`. Everything is plain YAML — open it, read it, edit it.

## Benchmark

**Retrieval** (LongMemEval R@5): **76.7%** out-of-the-box · **97.0%** with openai-3-large embeddings

**Agent task impact:** Haiku + PLUR outperforms Opus *without* memory at ~10× less cost. House rules: **12–0** across Haiku, Sonnet, Opus. A/B win rate: **89%**.

[Full methodology →](https://plur.ai/benchmark.html)

## Related packages

| Package | For |
|---------|-----|
| [`@plur-ai/core`](https://www.npmjs.com/package/@plur-ai/core) | Engine — use directly in custom agent frameworks |
| [`@plur-ai/claw`](https://www.npmjs.com/package/@plur-ai/claw) | OpenClaw — automatic memory without MCP |

## License

Apache-2.0 · [GitHub](https://github.com/plur-ai/plur) · [plur.ai](https://plur.ai)
