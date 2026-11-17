# Next release — retrieval and injection overhaul (draft)

Draft release notes for the overhaul branch. Every behaviour change a user or
an integrator can notice is listed here; fill in the version at release time.

## Injection

- **Unified injection is opt-in.** `injection.mode: unified` in `config.yaml`
  builds the injected block from recall's ranked list behind the always-on
  pinned slot. The default stays `legacy` for this release, kept as the
  rollback path. Related keys: `injection.recall_limit` (default 20),
  `injection.prohibition_ratio` (0.2), `injection.query_min_terms` (4),
  `injection.min_relevance_signal` / `injection.min_relevance` (no cut-off by
  default: no signal met the bar of emptying the task section on unrelated
  prompts while losing at most 1 target in 30. The nearest, `cosine` at
  0.714, empties it on about half of unrelated prompts and loses about 1
  target in 22; set it only if you prefer that trade).
- **Pins once per context.** Pinned engrams are injected on the first prompt
  and after a compaction (or resume), not on every skill, agent or plan-mode
  event in the same context. A subagent is its own context: it gets the pins
  once (keyed per subagent id). A delivery is recorded only when the block
  actually held a pinned engram, so a failed or pin-less injection never
  suppresses later ones.
- **Event hooks use the unified pipeline, keyword-first.** Plan-mode, skill,
  agent and subagent events run the same selection as the first prompt. They
  take the keyword leg unless the embedding model is on disk, the embeddings
  cache is warm and no other hybrid run of the session is live; an event
  never downloads the model, never starts the background cache build and
  never contacts a team server (except in a remote-only folder, which has no
  local store).
- **Event hook timeout 20 s.** `plur init` now registers the event hooks with
  the main hook's 20 s. Installs made before keep 10 s and keep working: an
  event run bounds itself to about 9.5 s in total. `plur doctor` names each
  event hook still registered below 20 s.
- **Vague prompts and event labels get session context** (stored session
  task, project scope label, git branch, last two user turns) added to the
  query.

## Pinning policy

- **`pinning.agents: allow | request | deny`** (default `allow`) decides
  whether an agent may pin. Under `request` an agent's pin is stored unpinned
  as a pin request for the owner (`plur pins review`); under `deny` it is
  refused.
- **The CLI is an agent when an agent runs it.** The CLI actor is the agent
  when an agent environment is detected (Claude Code, Codex, the Cursor agent,
  Gemini CLI / Antigravity, opencode) or stdin is not a terminal, unless
  `PLUR_ACTOR=owner` is set. Under `request` / `deny`, `plur pin`,
  `plur pins review approve`, `plur pins apply` and `consolidate` / `enrich` /
  `rescope --apply` also need a confirmation typed at an interactive terminal.
  Scripts that relied on the CLI always being the owner under a restrictive
  policy must now be run from a terminal.

## New commands

- `plur pins` — fit report (priority, tier, cost, overflow), `priority`,
  `review approve|reject`, `audit` (asks a model which pins apply to every
  task; writes a proposal into the store root by default, changes nothing),
  `apply <file> --yes` (one journalled change) and `undo <change-id>`.
- `plur consolidate --plan | --apply <file> --yes | --undo <id>` — the memory
  optimiser: proposes merges of near-duplicate clusters; applying needs
  `consolidate.apply_enabled: true` and starts with a one-item trial
  (`--limit 1`). `consolidate.threshold` (0.85) and
  `consolidate.nightly_max_changes` (25) tune it.
- `plur enrich --plan | --apply <file> --yes | --undo <id>` — labels each
  memory's kind, task family, outcome and when it applies.
- `plur rescope --plan | --apply <file> --yes | --undo <id>` — proposes a
  scope for global engrams and moves locally owned ones as one undoable
  change.
- Plan and proposal files quote memory text: they are written atomically,
  owner-only (0600) and never through a symlink.

## Models for the new commands

- **`PLUR_LLM_CMD` bridge.** `--llm-cmd "<command>"` or `PLUR_LLM_CMD` runs a
  host model command with the prompt on stdin and the reply on stdout (for
  example `claude -p --model opus`); `PLUR_LLM_MODEL` names the model recorded
  on results, `PLUR_LLM_TIMEOUT_MS` bounds each call (default 10 minutes).
- **No environment-key fallback for the new commands.** `consolidate`,
  `enrich` and `pins audit` never pick up `OPENROUTER_API_KEY` /
  `OPENAI_API_KEY` on their own; with no explicit bridge they refuse.
  `plur tensions --scan` keeps its existing fallback.
- An OpenAI-compatible endpoint is given with `--llm-base-url` (https, or
  plain http to a loopback address only) and `--llm-api-key-env <VAR>`.
  `--llm-api-key <key>` still works but warns: it lands in shell history and
  the process list.

## Learning and search

- **Exact restatements reinforce via MCP.** `plur_learn`, `plur_learn_batch`
  and `plur_session_end` reinforce an existing active engram in the same
  scope when the new statement is equal after normalising case, whitespace
  and punctuation (`decision: REINFORCE` with `existing_id`), instead of
  writing a duplicate. Never similarity-only. `learn.reinforce_exact` in
  `config.yaml` decides when set (the CLI and library default stays off).
- **`structured_data.body` is searchable.** `learn` accepts a validated
  structured body (`--body`, `--kind`, `--outcome` on the CLI) and the body is
  part of the search text. The Postgres tier re-derives its stored search
  text once, in its non-blocking background backfill (`plur reindex-tokens`
  forces it); embedding caches re-embed only the rows whose text changed.

## Speed on large stores

- **Keyword search tokenises each memory once per process** instead of three
  times per query. Same results; on a 14k-memory store a unified injection
  went from about 11 s to under 9 s from the CLI.
- **Binary companion for the embedding cache.** After the JSON cache is read,
  its vectors are also written to `.embeddings-cache.vectors.bin` (exact
  float64 copy). Later processes read that file while the JSON is unchanged
  (same size, modification time and inode) and fall back to the JSON
  otherwise. It is derived, git-ignored and never synced; deleting it is safe.
  It roughly takes the store's vector count × dimension × 8 bytes on disk
  (about 50 MB for 16k memories at 384 dimensions).
- **Hooks keep a finished ranking.** A hook racing its deadline now tells core
  when it needs the answer (`bookkeeping_deadline_at`); the best-effort
  injection counter (a whole-file write on YAML stores) is skipped when less
  than 2 s is left, instead of making the hook throw away a finished result.
  The search itself is not cut short.
- On the 14k-memory store a first-prompt hook in unified mode now finishes in
  about 6 s and an event in about 3–4 s.
- `plur inject --json` reports the unified relevance signals (`relevance`).
- **A late hybrid result is kept.** When a hook's hybrid search misses its
  deadline, it now races the keyword fallback and the hook keeps whichever
  finishes first. Before, a long query could leave an event with nothing:
  the fallback started from scratch and neither finished in time. The racing
  fallback skips its best-effort injection counter, so no store write is cut
  off at exit.
- **`injection_budget` reaches every path.** `plur inject` uses it unless
  `--budget` is given (it was a fixed 2,000); skill, agent and plan-mode
  event hooks use it when it is above their 3,000 floor (it was a fixed
  3,000).
- **Unified task list default raised to 20** (`injection.recall_limit`, was
  10). On the 14k-memory store it lifted the hook path on real-session
  questions from 15 to 17 of 30 at session start and from 13 to 15 on agent
  events, with no empty contexts.

## Configuration robustness

- An invalid value in any of the new keys (`injection.mode`,
  `injection.recall_limit`, `injection.prohibition_ratio`,
  `injection.query_min_terms`, `injection.min_relevance_signal`,
  `injection.min_relevance`, `pinning.agents`, `consolidate.*`,
  `learn.reinforce_exact`) is ignored on its own — the default applies and
  the rest of `config.yaml`, stores included, still loads. `plur doctor`
  names each ignored key.

## Downgrade caveat

- An older release ignores the new `config.yaml` keys. They stay in the file
  (PLUR edits `config.yaml` as YAML and never writes back its parsed form),
  but while the older version runs: `injection.mode: unified` falls back to
  the legacy selection, **`pinning.agents` is not enforced** (agents can pin
  again), and the CLI is the owner as before. Event hooks registered by this
  release still call `plur hook-inject --event …`, which older releases
  handle with their own pipeline.
- Older releases strip unknown keys from the `injection` block when they parse
  it. From this release on, unknown `injection` keys are kept (passed
  through), so keys a later release adds survive a downgrade to this one.
- Pin requests (`structured_data.pin_request`) and journalled changes written
  by this release are inert in older versions: an older release neither
  shows the requests nor can undo the changes. Approve or reject pending
  requests and undo any change you may want undone before downgrading.
