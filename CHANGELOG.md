# Changelog

## 0.6.0 (2026-04-01)

### Multi-Store: Share Knowledge Across Teams

PLUR now reads engrams from multiple stores. Your team's learned knowledge lives in their git repo — PLUR reads it alongside your personal memory. No copying, no syncing. Just add a store path and your agent knows what the team knows.

```yaml
# ~/.plur/config.yaml
stores:
  - path: ~/projects/my-team/engrams.yaml
    scope: my-team
    readonly: true
```

Or register via CLI: `plur stores add ~/projects/my-team/engrams.yaml --scope my-team`

- Store engrams get namespaced IDs (`ENG-DFD-2026-0401-001`) to prevent collisions
- Scope validation: store engrams auto-narrow to their scope, mismatched scopes skipped
- Feedback and forget route to the correct store (readonly stores reject writes gracefully)
- mtime-based cache: no re-parsing YAML files that haven't changed

### Performance: SQLite Index Default

`index: true` is now the default. At 600+ engrams, every recall was parsing 80KB of YAML. SQLite index makes filtered queries instant. The index syncs across all stores automatically.

### Packages
- `@plur-ai/core` 0.6.0 — multi-store reads, mtime cache, store-aware writes, index default
- `@plur-ai/mcp` 0.6.0 — graceful readonly feedback, one-command init, cold start fixes
- `@plur-ai/cli` 0.6.0 — hook-inject, plur init, stores commands
- `@plur-ai/claw` 0.6.0
- `plur-hermes` 0.6.0

### Update
```
npm update -g @plur-ai/mcp @plur-ai/cli
pip install --upgrade plur-hermes
```

## 0.5.2 (2026-04-01)

### Cold Start Fix (#7)
- `plur_session_start` returns store stats (engram count, episodes, packs) and contextual guides
- Empty store gets actionable messaging: "You have 0 engrams. Call plur_learn..."
- Fresh install triggers `setup_hint` suggesting `npx @plur-ai/mcp init`
- `plur_session_end` returns hint when no engrams captured

### One-Command Setup
- `npx @plur-ai/mcp init` now does everything: storage + MCP config + Claude Code hooks
- `plur init` (CLI) installs hooks only, for users with existing MCP config
- `plur hook-inject` — hook handler for automatic engram injection on first message
- `plur hook-inject --rehydrate` — re-inject engrams after context compaction

### Stronger Instructions
- MCP INSTRUCTIONS split into REQUIRED (session boundaries, corrections) vs OPTIONAL (feedback, recall)
- Concrete triggers ("when user corrects you") instead of vague "use proactively"

### Packages
- `@plur-ai/core` 0.5.2
- `@plur-ai/mcp` 0.5.3 — cold start fix, one-command init, stronger instructions
- `@plur-ai/cli` 0.5.4 — init, hook-inject commands
- `@plur-ai/claw` 0.5.2

### Update
```
npm update -g @plur-ai/mcp @plur-ai/cli
```

## 0.5.0 (2026-03-31)

### Session Management
- `plur_session_start` — inject relevant engrams at session start, returns session ID + context
- `plur_session_end` — capture learnings as engrams + record episode at session end

### Extended Learning
- `plur_learn` now accepts: tags, rationale, visibility, knowledge_anchors, dual_coding, abstract, derived_from
- Pack engram feedback — rate pack engrams, not just personal ones
- `plur_promote` — activate candidate engrams (single + batch)

### Improved UX
- Batch `plur_feedback` — rate multiple engrams in one call
- Search-mode `plur_forget` — find engram by keyword, not just ID
- `injected_ids` returned from inject tools — structured feedback loop
- `plur_packs_export` — export filtered engrams as shareable packs
- `plur_ingest` CLI command — extract engrams from stdin

### Packages
- `@plur-ai/core` 0.5.0 — extended LearnContext, getById, pack feedback, injected_ids
- `@plur-ai/mcp` 0.5.0 — 24 tools (was 18), session management, promote, export
- `@plur-ai/claw` 0.5.0 — enriched LearnContext in auto-learning, injected_ids in assembler
- `@plur-ai/cli` 0.5.3 — promote, stores, ingest commands, batch feedback, search forget
- `plur-hermes` 0.5.0 — extended bridge (all new features), ingest tool, batch feedback

### Update
```
npm update -g @plur-ai/mcp @plur-ai/cli
pip install --upgrade plur-hermes
```

## 0.4.2 (2026-03-28)

Initial public release. Core memory engine, MCP server, OpenClaw plugin, CLI.
