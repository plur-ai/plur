# Changelog

## Unreleased

### Multi-Project Setup Improvements (#19)

- **Default to project-level config**: `plur init` now creates `.claude/settings.json` in the current directory by default, instead of falling back to `~/.claude/settings.json`. Better for multi-project setups. Users who want global config can use `--global` flag.
- **Improved documentation**: Clarified that `--domain` and `--scope` flags (added in v0.8.2) are the solution for multi-project scoping. Updated init output to explain this workflow.

Note: Issue #19 reported three problems. Issues 1 & 2 are now resolved. Issue 3 (batch/workspace mode) remains open for future consideration.

### Packages

- `@plur-ai/cli` 0.8.3 — default to project-level config, improved multi-project docs

## 0.8.2 (2026-04-09)

### Architecture Clarity & Multi-Project Scoping

Clarifies PLUR's architecture: **global tool, per-project scoping**. One MCP server, one engram store, available everywhere. Multi-project users scope via domain/scope fields — not per-project installations.

- **Hook-driven session start**: `hook-inject` now auto-generates a session ID on first message — no need for explicit `plur_session_start` call. Session ID is included in injected context for `plur_session_end`.
- **Project config (`.plur.yaml`)**: `plur init --domain X --scope Y` writes a `.plur.yaml` in the project root. Hooks read this file and auto-apply domain/scope to injection and learn reminders.
- **Improved init messaging**: `plur init` output now explains the global architecture and scoping model.
- **CLAUDE.md template rewrite**: Clearer architecture section, documents auto-session and multi-project scoping. Removed verbose sections in favor of concise guidance.
- **MCP server instructions updated**: Clarifies hook-driven lifecycle vs manual session start.
- **README multi-project docs**: Install section documents `--domain`/`--scope` workflow.

### Packages

- `@plur-ai/core` 0.8.2 — version bump
- `@plur-ai/mcp` 0.8.2 — updated instructions, init messaging, CLAUDE.md template
- `@plur-ai/cli` 0.8.2 — `.plur.yaml` support, auto session start, improved init output
- `@plur-ai/claw` 0.8.2 — version bump

## 0.8.0 (2026-04-08)

### Competitive Absorption: 50+ Features from 7 Memory Systems

50+ improvements absorbed in one session from Mem0, Claude-Mem, Mengram, Forge, Lossless Claw, OB1, and II-Agent. Implemented across 5 sub-projects, benchmarked, zero regressions.

- 75% faster learn/recall/inject
- 10% fewer injection tokens
- LLM-driven dedup (opt-in)
- Three-memory taxonomy

### Memory Intelligence (SP1)

- `learnAsync()` method: pre-store dedup pipeline — content hash → semantic recall → LLM decision (ADD/UPDATE/MERGE/NOOP)
- Commitment levels on engrams: exploring / leaning / decided / locked
- Tension detection: surfaces contradictions between engrams at learn time
- Confidence decay with 90-day grace period from deployment
- Content hash fast-path deduplication (SHA256 of normalized statement)

### History & Evolution (SP2)

- Event-sourced history in `~/.plur/history/YYYY-MM.jsonl` (true append-only)
- Version lineage: engrams track `engram_version` and reference previous version in history log
- `plur_history(engram_id?)` tool for auditing engram evolution
- `plur_episode_to_engram()` promotes episodic timeline events to episodic engrams
- `plur_report_failure()` for failure-driven procedure evolution (rewrites procedures after failures, max 3 revisions/24h)

### Retrieval & Injection (SP3)

- Progressive disclosure: top 30% relevance get full detail, next 40% get statements, rest get index lines
- `recallAuto()` search orchestrator: auto-selects BM25 / hybrid / expanded based on query characteristics
- Fresh tail boost: engrams from last 7 days get +0.2 retrieval strength (exploring/leaning only)
- Cognitive profile synthesis via `plur_profile()`: LLM-generated narrative summary from engram corpus, cached 24h
- Bounded sub-agent expansion with token budgets and caller session tracking
- Cost-aware model routing for LLM operations (dedup / profile / meta tiers)

### Infrastructure (SP4a + SP4b)

- Migration system with timestamp-based IDs, opt-in CLI (`plur migrate`), auto-backup
- Schema passthrough: unknown fields preserved through serialize/deserialize cycle
- Storage factory pattern: YamlStore (default) + SqliteStore (opt-in for scale)
- Async-first internals using `async-mutex` and `fs/promises`

### Benchmarks

- New `benchmark/run.ts` — LongMemEval harness (30 scenarios, 6 categories) committed permanently
- New `benchmark/micro.ts` — per-operation latency micro-benchmark with LLM dedup validation
- Both runnable on any branch: `npx tsx benchmark/run.ts` and `--compare a b`

### Deferred to 0.9.x

- Vault export (Obsidian-compatible markdown)
- Pack registry discovery (GitHub-hosted)
- Python SDK

### Packages

- `@plur-ai/core` 0.8.0 — all SP changes
- `@plur-ai/mcp` 0.8.0 — new tools: plur_history, plur_profile, plur_tensions, plur_report_failure, plur_episode_to_engram
- `@plur-ai/cli` 0.8.0 — version bump
- `@plur-ai/claw` 0.8.0 — version bump (features available via core)

## 0.7.3 (2026-04-02)

- Fix OpenClaw compat: remove pluginApi:"1" that blocked install on OpenClaw >=2026.3.31

## 0.7.2 (2026-04-02)

- Learning reflection hook: Stop hook nudges plur_learn every 3rd response — catches reasoning moments that tool-level hooks miss
- Claw system prompt updated to v3: session workflow, pack commands, correction protocol, verification rules
- Claw /packs slash command: list, install, uninstall from OpenClaw
- 9 hooks installed by plur init (was 8)

## 0.7.0 (2026-04-02)

### Knowledge Packs: Share What You Know

Knowledge Packs are thematic engram collections you can share with your team, community, or across machines. Export what you've learned about a domain, share the pack, and anyone can install it.

- Thematic export: `plur packs export react-patterns --domain code.react --tags hooks,state`
- Privacy scan on export: blocks secrets and private engrams, warns on personal paths and emails
- Conflict detection on install: flags duplicates and contradictions with existing engrams
- Uninstall: `plur packs uninstall <name>`
- Integrity hash (SHA256) per pack for tamper detection
- Auto-derived match_terms from engram tags and domains
- Internal references stripped on export (clean, portable packs)
- Output to ~/plur-packs/ (visible, easy to find and share)

### Full Memory Lifecycle Hooks

`plur init` now installs 8 hooks (was 2). Your agent gets contextual memory injection at every stage:

- Plan mode entry: broad context for architecture decisions
- Skill invocation: domain-specific engrams for the skill being used
- Agent spawn: scoped engrams for the agent's task
- Subagent start: memory carried into subagents
- Observation capture: tool calls logged for offline pattern extraction

### Observation Capture

New `hook-observe` command logs tool calls to ~/.plur/observations/ for deterministic pattern extraction. Hooks fire 100% of the time vs LLM-driven learning at ~80%.

### Packages
- `@plur-ai/core` 0.7.0 — thematic export, privacy scan, conflict detection, uninstall, integrity hash, export sanitization
- `@plur-ai/mcp` 0.7.0 — plur_packs_uninstall tool, improved export with thematic filtering, 8 hooks on init
- `@plur-ai/cli` 0.7.0 — hook-observe command, hook-inject --event for contextual injection, packs uninstall
- `@plur-ai/claw` 0.7.0 — version bump (pack features available via core)

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
