# @plur-ai/opencode

**PLUR memory plugin for [opencode](https://opencode.ai) — persistent learning across sessions, no tool call required.**

Part of [PLUR](https://plur.ai) — the engram exchange layer connecting agents across tools. Compatible with the MCP server ([`@plur-ai/mcp`](https://npmjs.com/package/@plur-ai/mcp)) for Claude Code, Cursor, and Windsurf, and with [`@plur-ai/claw`](https://npmjs.com/package/@plur-ai/claw) for OpenClaw. One store, shared across every PLUR-compatible tool.

> **This package must be published on npm before it works.** opencode resolves
> a bare plugin name — `plugin: ["@plur-ai/opencode"]` — by having Bun fetch it
> from the npm registry at plugin-load time. Until `@plur-ai/opencode` is on
> npm, that entry silently resolves to nothing: **no error appears anywhere in
> opencode's log.** The config looks correct, opencode starts normally, and no
> memory ever reaches the model. This was found the hard way, by the live
> acceptance gate below, before the package was published — see [Live
> acceptance gate](#live-acceptance-gate). If you are reading this before the
> npm listing exists, `plur init --opencode` will write a config entry that
> does nothing yet.

## What it does

Once installed, opencode's agents get memory automatically:

- **Recall** — relevant engrams from past sessions are found and rendered into a memory block once per user turn.
- **Injection** — that block is placed in the system prompt on every model request, at no extra recall cost within the turn.
- **Learning** — two paths, mirroring [`@plur-ai/claw`](../claw): the model's own `🧠 I learned:` self-report, and user corrections/preferences detected at confidence ≥ 0.7.
- **Compaction survival** — before opencode compacts a session's context, the current memory block is carried into the compaction prompt and anything not yet learned is learned first.

Everything is stored as plain YAML in `~/.plur/` — the same store `@plur-ai/mcp`, `@plur-ai/claw`, and every other PLUR integration read and write. Teach it once in Claude Code, recall it in opencode.

## Install

```sh
npx @plur-ai/cli init --opencode
```

This writes two things into opencode's global config (`~/.config/opencode/opencode.json`, or `.jsonc` if that's what you already have):

- `plugin: ["@plur-ai/opencode"]` — the automatic layer described above.
- `mcp.plur` — the explicit `plur_*` tool surface from `@plur-ai/mcp`, for when you want the agent to query or teach memory on demand.

`plur init` auto-detects opencode (it runs this step whenever `~/.config/opencode` already exists) — you don't need the flag if opencode is already installed. Pass `--no-opencode` to skip it.

### Manual `opencode.json`

If you'd rather edit the config by hand, or `plur init` reports your config is in a shape it won't touch (see below), the equivalent is:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@plur-ai/opencode"],
  "mcp": {
    "plur": {
      "type": "local",
      "command": ["npx", "-y", "@plur-ai/mcp"],
      "enabled": true
    }
  }
}
```

`plur init --opencode` merges into an existing config — it only ever adds to `plugin` and sets `mcp.plur`, never touching your other keys (`model`, `theme`, `permission`, …). If your existing `opencode.json`/`.jsonc` doesn't parse as JSON, or `plugin`/`mcp` already hold something other than an array/object, it refuses and leaves the file untouched rather than guessing — add the two keys above by hand in that case.

## Verified version

Everything in this package was measured against a real binary, not documentation: **opencode 1.18.30** / **`@opencode-ai/plugin` 1.18.30**, 2026-09-15. See [ARCHITECTURE.md](ARCHITECTURE.md) for what was measured and why it shaped the code.

Both of the hooks this plugin depends on carry opencode's `experimental.` prefix. If a future opencode release renames or removes one, the plugin degrades — see [Failure posture](ARCHITECTURE.md#failure-posture) — rather than breaking your agent, but the degraded mode (`chat.message` fallback) has a real cost: it re-accretes a stale memory block into session history every turn. `RenderPath` detects the fallback condition and logs it (`PLUR_DEBUG=1`); it does not fix it.

## Diagnostics

```sh
PLUR_DEBUG=1 opencode run "..."
```

Logs one line per hook invocation to stderr — scope root resolution, project scope/domain if `.plur.yaml` sets one, recall counts, and whether the `system.transform` fallback has latched. Silent otherwise; the plugin never writes to stdout or interrupts a turn on a memory-store failure.

## What leaves your machine

Nothing. `@plur-ai/core` makes no external network calls — search is local BM25 (optionally + local embeddings), storage is YAML on disk at `~/.plur/` (override with `PLUR_PATH`). This plugin wires no telemetry of its own.

## Scope

Project scoping mirrors `@plur-ai/mcp`: if a `.plur.yaml` file is found walking up from the resolved scope root, its `scope` and `domain` become the default for recall and for anything this plugin learns. The `cwd` passed to the underlying `Plur` constructor drives store auto-discovery only — it does not by itself create a per-project store or filter what is recalled; `.plur.yaml` is what does that.

The scope root itself prefers opencode's `worktree`, but falls back to `directory` — `worktree` was measured as `"/"` outside a git repository (opencode 1.18.30), which would otherwise scope every non-repo session to the filesystem root.

## Live acceptance gate

Unit tests prove the hooks return the right objects. They cannot prove memory actually reaches the model — the documented failure mode for PLUR plugin releases is a plugin that loads, registers, reports healthy, and injects nothing (this is exactly what happened here before publishing was fixed; see the warning at the top of this file). `test/e2e.manual.mjs` is a separate, manual gate that builds the real publishable artifact (packed tarballs, not a `dist/` copy — `tsup` does not bundle `@plur-ai/core`, so a bare directory copy can't resolve its own dependency), installs it the way a real user would, and drives a real opencode session against it.

It asserts three things:

1. **Recall reaches the model** — a fresh session, given a question about a fact seeded in an earlier one, answers it.
2. **The injection path is live** — a read-only observer plugin confirms the PLUR header is present in the rendered `system[]` array.
3. **No transcript accretion** — across a 3-turn continued session, the observer's message-history block count is 0 on every turn.

It is **not** part of `pnpm test` and does **not** run in CI. It needs:

- A real opencode binary on `PATH`.
- `opencode auth login` already run (it copies your real auth into an isolated harness — it never touches your real `~/.config/opencode` or `~/.local/share/opencode`).
- Network access (the model call itself).

Run it with:

```sh
node packages/opencode/test/e2e.manual.mjs
```

Environment knobs:

| Variable | Default | Effect |
|---|---|---|
| `PLUR_E2E_MODEL` | `openai/gpt-5.5` | Model to drive the gate with. |
| `PLUR_E2E_FULL` | unset (BM25-only) | Set to `1` to exercise the hybrid/embedding recall path. Local embeddings load inside the opencode process and can OOM a loaded machine; the default runs BM25-only, which is sufficient for all three assertions since the seeded fact uses distinctive tokens. |
| `PLUR_E2E_KEEP_TMP` | unset | Set to `1` to keep the temporary harness directory (packed tarballs, isolated XDG dirs, observer log) after the run for inspection. |

## Related packages

| Package | For |
|---------|-----|
| [`@plur-ai/mcp`](https://www.npmjs.com/package/@plur-ai/mcp) | Claude Code, Cursor, Windsurf (MCP server) |
| [`@plur-ai/claw`](https://www.npmjs.com/package/@plur-ai/claw) | OpenClaw ContextEngine plugin |
| [`@plur-ai/dsh`](https://www.npmjs.com/package/@plur-ai/dsh) | DeepSeek Harness plugin |
| [`@plur-ai/core`](https://www.npmjs.com/package/@plur-ai/core) | Engine — use directly in custom agent frameworks |

## License

Apache-2.0 · [GitHub](https://github.com/plur-ai/plur) · [plur.ai](https://plur.ai)
