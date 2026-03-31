# Changelog

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
