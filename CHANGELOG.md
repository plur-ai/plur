# Changelog

## Unreleased

### Added

- **`plur receipt` + `plur_receipt` MCP tool — the memory receipt.** A counted, local, read-only report of what your memory actually retrieved for you: how many times a memory you taught PLUR was put in front of the model, how many distinct engrams it drew on, which are most relied on (with their statement text), and how much of the store is dormant. Every figure is directly counted — there is no estimate, no counterfactual, and deliberately no dollar or token-savings figure (on a subscription your marginal token cost is zero; the value of an avoided rediscovery is not measurable from this data). Scoped to local memory (primary store + installed packs) so the number is identical from the cold CLI and the warm MCP server; retrievals of team-store engrams are reported separately, never as deletions. States its own coverage window so the numbers are never misread as lifetime figures. Nothing leaves the machine.
- **`co_injection` history events now record `tokens_used` and the calling `source`** (`session_start` / `inject` / `hook`), and every injection call site is tagged. Hook retrievals — the large majority — now also carry the session id, so the receipt's (engram, session) unit is well-defined. Events written before this change remain fully readable.

### Fixed

- **Security: `plur status --json` printed live enterprise bearer tokens.** `StatusResult` embeds the full `PlurConfig`, so `--json` piped the `stores[].token` values (live credentials for the configured enterprise servers) to stdout — into CI logs, pasted issues, and agent transcripts. All CLI JSON output is now credential-redacted at the output boundary, so every present and future JSON command inherits the protection. Redaction also masks credentials embedded in string values (URL userinfo, e.g. `https://user:pass@host`), which a key-based denylist cannot reach.
- **Security: hardened the memory receipt against hostile engram statements.** Statement text can come from third-party installed packs, so the "most relied on" snippet — which prints to the terminal and is returned to the calling agent — is now sanitized: ANSI/terminal escapes and other C0/C1/DEL controls, Unicode line/paragraph separators, and bidi (Trojan-Source) reordering + zero-width spoofing characters are stripped before rendering, and truncation is grapheme-safe.
- **Scope routing was inert for remote scopes — server `covers[]` never reached the client** (#668). The Stage-3 ranker (`suggestScope`) routes on the `covers[]` declared on local config store entries, but nothing ever populated them from the server, so it returned no candidates for team scopes and team-relevant writes silently defaulted to `global`/`personal:*`. `discoverRemoteScopes` — the `/me` pull behind session start, `plur_scopes_discover`, and scope registration — now mirrors each registered scope's server-authoritative `covers`/`description`/`sensitivity` into local config, idempotently, refreshing them when the server value changes. Personal-family and local stores are left untouched; a failed `/me` never wipes existing covers.

## 0.16.0 (upcoming)

### Added

- **`plur scopes` — per-scope opt-out for authorized-but-unregistered scopes** (#647, #656): a new user-facing CLI to register, dismiss, or re-offer the shared scopes your enterprise token is authorized for, one at a time — instead of the old all-or-nothing `register:true`. `plur scopes` lists them (with each scope's description); `plur scopes register <scope>` adds one; `plur scopes dismiss <scope>` remembers "don't offer this again" (persisted to `config.yaml`); `plur scopes --reoffer` clears dismissals. Dismissed scopes are excluded from the list and from the session-start hint, so PLUR stops re-listing scopes you've deliberately skipped. The session-start hint is now a quiet one-liner pointing at `plur scopes` (it was agent-facing guide text that users never saw).

## 0.15.0 (2026-07-21)

Lean default, LangChain, MCP SDK v2.

- lean default — 74% fewer tokens
- plur-langchain Python package
- MCP SDK v2 (split packages)
- Windows path + ID uniqueness fix

### Changed

- **Lean tool profile is now the default** (#625): the MCP server exposes 11 tools (down from 40) to every consumer — Claude Code, Cursor, Windsurf, OpenClaw, Hermes, and nightshift agents alike. Per-turn tool-schema overhead drops ~74% (~2K vs ~9K tokens). All 40 tools remain reachable via `plur_admin { action: "<tool>", args: {...} }`. Restore the full surface with `PLUR_TOOL_PROFILE=full`. **Consumers that depend on all 40 tools being available by default must either call via `plur_admin` or set `PLUR_TOOL_PROFILE=full`.**
- **MCP SDK v2 migration** (#638): `@plur-ai/mcp` now uses the MCP SDK v2 split packages (`@modelcontextprotocol/server`, `@modelcontextprotocol/client`, `@modelcontextprotocol/core` @ 2.0.0-beta.4), replacing the monolithic `@modelcontextprotocol/sdk@^1.12.0`. Prepares for the MCP spec stable release (2026-07-28). The public API of `@plur-ai/mcp` is unchanged; 226 tests pass.

### Added

- **`plur-langchain` adapter** (#529): new Python package providing a LangChain `BaseMemory` + `BaseChatMessageHistory` adapter. Install with `pip install plur-langchain`. Chains and LCEL pipelines now get persistent engram memory with zero extra wiring.

### Fixed

- **`plur_recall_hybrid` fails with `ENOENT: mkdir ''` on Windows** (#641, #642): `saveCache` extracted the directory with `cachePath.lastIndexOf('/')`, which returns -1 on Windows backslash paths — `substring(0, -1)` yields `''`, and `mkdirSync('')` throws ENOENT. Replaced with `path.dirname()` (cross-platform) and added a guard against empty dirname. `plur_recall` / `plur_learn` / `plur_doctor` were unaffected; only the hybrid path (`plur_recall_hybrid`) hit `saveCache`. Regression tests added (4 cases, offline mock embedder).
- **Dependency security overrides** (#632): tightened transitive dependency overrides addressing 30 Dependabot alerts across `openclaw`, `undici`, `linkify-it`, and `js-yaml`.
- **`generateInjectionId` / `generateEventId` cross-process uniqueness** (#596): IDs are now unique across processes started within the same millisecond. Replaced `Date.now() + 4-char random suffix` with a per-process counter — eliminates the ~0.07% birthday-collision chance per 50-call batch and removes the intermittent `expected 49 to be 50` flake in co-injection tests.
- **`RemoteStore.load()` — no cache poisoning on mid-pagination error** (#550): a network or server error mid-way through a paginated remote load no longer overwrites the local cache with partial data. The local cache is only updated after a complete, successful load.
- **PID salt for cross-process ID uniqueness** (#600): ID generation now includes the process ID as a salt, preventing collisions between sibling processes (e.g. parallel nightshift agents) that start in the same millisecond.

## 0.14.0 (2026-07-15)

A hardening release — 24 issues closed.

- sharper recall + reranker fixes
- hardened shared-scope metadata
- feedback + hook reliability
- CLI pack management

A reliability and hardening release: memory-quality, feedback, and security fixes across recall and shared-scope handling, plus CLI pack management and richer status filters. npm `latest` moves 0.13.0 → 0.14.0; 0.12.0 remains deprecated.

### Changed

- **batchDecay removed — decay is a read-time property, not a scheduled job** (#563). The weekly/cron decay pass materialized elapsed-time decay back into stored `retrieval_strength`, which both double-counted against the read-time decay already applied at injection and mutated provenance on a timer. Decay is now computed only at read time (`decayedStrength` over `last_accessed`), and reinforcement re-anchors `last_accessed` on access. The `plur batch-decay` CLI command and `plur_batch_decay` MCP tool are **removed** — any cron or client still invoking them will get an "unknown command/tool" error, so delete those schedules. There is no replacement scheduled job, by design. The superseded-engram "decays 2× faster" path lived only inside batchDecay and is gone with it; superseded engrams are still de-prioritized at injection time by the ×0.3 historical-intent penalty, which is unaffected.
- **`plur_learn_batch` output contract** (#281, #572) — *breaking for direct MCP consumers*: on partial failure, `ids` is now a 1:1 input-aligned array with `null` in each failed slot, instead of a compacted array of only the successes. A client indexing `ids` positionally against its inputs was silently misattributing IDs on any partial failure; it now lines up. Update anything that assumed `ids.length === successCount`.
- **`plur login` groundwork landed but is not active** (#532): the enterprise OAuth device-flow login implementation shipped in the tree but is **intentionally not registered** in the CLI dispatcher — `plur login` returns "Unknown command." It is happy-path only (no paste-token fallback, a hard dependency on server device-flow endpoints, no refresh tokens), so it is deactivated pending that hardening and will be enabled in a later release. See #300.

### Fixed

- **Reranker fit-check judges relevance, not co-membership** (#451, #565): the per-store `plur doctor` reranker gate built its pairs from same-domain co-membership, which a cross-encoder can't meaningfully score. It now synthesizes a probe query per engram and scores (probe, own-doc) as positive vs (probe, cross-domain-doc) as negative, so the gate measures whether a reranker actually helps a given store.
- **Commitment and confidence render as distinct fields** (#348, #564): `formatLayer3` overloaded a single slot; the injected line now shows `Commitment: <tier> | Confidence: <float>`, so a decided/locked commitment is no longer misread as a confidence value.
- **Historical-intent match is word-boundary, not substring** (#481, #567): substring matching false-positived ("prior" ⊂ "priority", "old" ⊂ "threshold", "was" ⊂ "wasm"), wrongly suppressing the superseded-engram penalty and injecting stale memory. Now anchored on word boundaries; multi-word keywords like "used to" match across any whitespace gap, including a newline or tab.
- **SessionEnd no longer destroys checkpoints; session_id path traversal closed** (#217, #568): the SessionEnd hook deleted the learn checkpoint even when the capture had failed, losing the session's learnings. It now deletes only after a confirmed capture and retains an unparseable checkpoint in place. A crafted `session_id` could also escape the sessions dir — now sanitized on both the write and read sides.
- **claw setup no longer destroys third-party OpenClaw config** (#51, #566): the stale-entry prune fired transiently during every install/upgrade and could delete other plugins' config entries, including their API keys. Removed; claw now seeds only what's absent and writes atomically.
- **EmbeddingGemma uses its model-card role prefixes, not E5's** (#483, #573): the opt-in `embedding-gemma` embedder applied E5-style `query:`/`passage:` prefixes instead of Gemma's `task: search result | query:` / `title: none | text:`, degrading recall. Fixed, with the embedder cache name bumped so the JSON embedding cache rebuilds automatically. **PGLite-backed stores (`PLUR_BACKEND=pglite`) on `embedding-gemma` must reindex once** with `plur sync --reembed --full`: that path keys on vector dimension, which didn't change, so it can't auto-detect the prefix change.
- **Scope metadata is length- and control-char-bounded on the remote path** (#345, #571): a hostile or MITM'd `/api/v1/me` could return an oversized or newline/control-char-laden scope `description`/`covers`, surfaced verbatim to the agent. These fields are now bounded (≤500 / ≤120 chars, ≤32 covers) and reject C0/C1 controls, DEL, and the U+2028/U+2029 line separators. This hardens against *structural* injection (faking a new instruction line); it does not, and cannot, filter a plain in-band instruction — treat scope metadata from an untrusted store as untrusted text. The local, user-authored config path is unaffected.
- **Feedback re-anchors `last_accessed`**: `plur_feedback` adjusted stored `retrieval_strength` without advancing `last_accessed`, so read-time decay immediately swallowed the adjustment — a >4× distortion on dormant engrams, exactly where a fade-vs-keep signal matters most. Feedback now re-anchors `last_accessed`, mirroring the reinforcement path.
- **Tension pre-filter stemming dropped** (#489, #570): the suffix-stemming step changed the labeled recall suite on zero pairs (29/30 with and without) while generating false positives ("states"/"station"/"stats" → "stat"); removed for precision.
- **Python SDK bridge robustness** (#495, #569), with the SDK's npx-fallback CLI pin now auto-bumped and verified at release so it can't ship pointing at a pre-fix CLI (#577).
- **Process-group orphan kill ported to the hermes bridge** (#575): the `plur-hermes` bridge now kills the whole process group on timeout (`start_new_session` + `killpg`), so a timed-out `npx @plur-ai/cli` can't orphan a runaway `node` grandchild.
- **Hooks fail open on an unwritable state dir** (#574): the session-guard, learn-check, and inject-lock hooks now proceed instead of crashing the prompt or tool call when their state directory isn't writable.
- **Assorted hook/remote robustness**: per-session concurrency lock for hook-inject (#519), AbortController coverage extended to the `RemoteStore.load()` body read (#531), and `isPlurConfigured` checks the home directory only when the working directory is under home (#521, #247).
- **`plur doctor` flags stale PGLite + embedding-gemma vectors** (#581): the companion diagnostic to the #483 caveat above — when the PGLite backend runs the opt-in `embedding-gemma` (whose vectors that backend does not auto-rebuild), doctor advises a one-time `plur sync --reembed --full`. Advisory only; it never fails the overall check.
- **claw warns non-destructively on orphaned OpenClaw config entries** (#583): #51 removed the destructive prune that deleted third-party plugin config — including embedded API keys — whenever a plugin dir was transiently absent during install. `plur doctor` now *warns* about genuinely-orphaned entries (PLUR's own and third-party) without ever deleting, restoring detection without the data-loss.

### Changed (cleanup)

- **Removed dead `strengthToStatus`** (#582): unused since batchDecay's removal, and its label vocabulary never matched the persisted `status` enum. The `dormant`/`candidate` enum values are retained (legacy/reserved) for backward-compatibility with stores written before #563 — removing them would reject existing data.

### Added

- **Session injection telemetry** (#536): per-pack activation tracking logged at `session_end` for offline relevance analysis.
- **`plur_status` domain + `created_after` filters** (#522, #524).
- **packs install/list/uninstall CLI subcommands** (#513), and the claw `before_prompt_build` migration with sharpened ClawHub positioning (#516).

### Release tooling

- The manifest gate (`release.sh`) now recognizes multi-issue commit trailers like `(#521, #247)` — the old extraction silently dropped every number in a comma trailer — and curates out this repo's internal `ops`/`cmo` commit types alongside the standard non-user-facing set. The canary smoke-test command substitution is also guarded under `set -e` (#578).
- **Publish verification hardened** (#584): the `@next` smoke test now covers `core` (install + ESM import, catching the import-time crash class that bricked `cli@0.9.2`) and `mcp`, not just `cli` — the audited fixes live in `core`. PyPI publish now verifies the version is retrievable after upload and prints an explicit recovery path on failure (PyPI is immutable). The session-guard's unwritable-state-dir fail-open now leaves a stderr audit trail instead of a silent bypass.
- The pre-release hardening pass for this release — the U+2028/U+2029 scope-metadata gap, multi-word historical-keyword matching, the `feedback()` `last_accessed` re-anchor, and the manifest-gate fix above — landed in (#579). The audit follow-ups (#581–#584) landed in (#585).

## 0.13.0 (2026-07-09)

Withdrawn — manifest-gate incident (#544). Cut ~90 minutes after 0.12.0 to walk back unintended features that weren't sufficiently tested. npm `latest` skips this version; upgrade directly to 0.14.0.

## 0.12.0 (2026-07-09)

Cursor IDE support (experimental/beta), plus a batch of queued core improvements: batch learning, supersedes chains, commitment tiers, reranker fit checks, session-end auto-close.

### Cursor IDE support (experimental/beta)

PLUR now works inside Cursor — its own hook system (`sessionStart`, `preToolUse`, `postToolUse`, `stop`), its own MCP config, and a reduced tool profile so PLUR doesn't blow Cursor's ~40-MCP-tool-per-workspace budget.

- **Install**: `npx @plur-ai/cli@0.12.0 init --cursor` (auto-detected too, if a `.cursor/` dir already exists in your project). Writes `.cursor/mcp.json`, `.cursor/hooks.json`, and `.cursor/rules/plur-memory.mdc`.
- **Reduced tool profile**: Cursor gets ~11 core tools (`plur_session_start`, `plur_learn`, `plur_recall_hybrid`, `plur_feedback`, `plur_forget`, `plur_session_end`, `plur_status`, `plur_doctor`, `plur_packs_uninstall`, `plur_tensions_purge`) plus **`plur_admin`**, a dispatch tool for everything else (`{ action, args }`) — instead of the full 39-tool surface, which alone would consume ~97.5% of Cursor's per-workspace MCP budget.
- **Memory delivery workaround**: Cursor's hook-output `additional_context` field is dropped by a confirmed race condition (acknowledged by Cursor's own team, no fix ETA), so PLUR delivers recalled memory and reminders through dynamically-rewritten `.cursor/rules/*.mdc` files instead — Cursor's rules engine reliably loads these.
- **`plur doctor`** now diagnoses Cursor-specific wiring (`.cursor/mcp.json` / `.cursor/hooks.json`, tool-profile env, live MCP tool count for both the full and Cursor profiles).
- **Why "experimental/beta"**: this integration has been through a full implementation review, an adversarial Codex review, and a 5-round multi-evaluator audit — but has **not yet been verified against a live Cursor install** (Cursor's hooks API is itself documented as beta and may change). Field-name assumptions (`conversation_id` vs `session_id`) and a couple of behaviors are confirmed via Cursor's own documentation and community forum, not a live run. Report issues at github.com/plur-ai/plur/issues.

### Added

- **`plur_learn_batch`** (#281): persist many engrams in one MCP call — same dedup + policy pipeline as `plur_learn`, partial-failure isolation, bounded LLM dedup cost.
- **Supersedes chain consumer behavior** (#481): inject prefers chain tips under budget pressure (unless the query is historical), recall annotates superseded engrams with their replacement, decay accelerates for low-recall superseded engrams. (The "decay accelerates for low-recall superseded engrams" behavior was **removed in 0.14.0** (#563): it lived only inside the batchDecay pass, which was retired. Superseded engrams are still de-prioritized at read time by the ×0.3 injection penalty — that part is intact.)
- **Commitment tier in injected text** (#348): `formatLayer3` shows the commitment label (`exploring`/`leaning`/`decided`/`locked`) instead of a raw confidence float when set.
- **Per-store reranker fit check** (#451): `plur doctor` scores whether a cross-encoder reranker is actually helping on a given store's domain, since out-of-domain rerankers can produce inverted scores.
- **`plur_session_end` wired to Claude Code's SessionEnd hook** (#217): memory lifecycle now auto-closes when a session ends, instead of depending on the agent remembering to call it.
- Python SDK bumped to 0.10.0 (`recall_hybrid`, npx pin fix).

### Fixed

- **Orphaned hook processes on degraded networks** (#504): `hook-inject` had no process-level ceiling and `RemoteStore.load()` made unbounded fetch calls — together these could accumulate dozens of orphaned processes and gigabytes of swap on a flaky connection. Added a self-watchdog (55s default ceiling) and a 30s fetch timeout with fail-open (cached engrams or `[]`, no cache poisoning).
- **Tension subject filter** (#489): suffix-stemming in the contradiction pre-filter. (The "77%→90% recall" figure originally published here was withdrawn on 2026-07-14 — re-running the commit's own 30-pair suite gives 29/30 both with and without stemming, changing the outcome on zero pairs. The number was never reproducible. See #489.)
- **`hook-learn-check`'s Stop-hook counter** made atomic (append-only, not read-increment-write) — the same race class found and fixed in the new Cursor hooks during their audit.
- Three OpenClaw (`@plur-ai/claw`) UX fixes: stale plugin-manifest pruning, `plugins.allow` seeding on fresh installs, `runtime_registered` verified via an actual filesystem check instead of a hardcoded placeholder.

### Changed

- Benchmarks consolidated into the standalone `plur-bench` repo; `benchmark/micro.ts` (core-operation latency) stays in-repo as `pnpm bench:micro`.

## 0.11.0 (2026-07-06)

Hooks that actually finish, tension lifecycle, migration importers.

- Injection hooks now install async — no more hook timeouts on large stores
- Event hooks switch to BM25 and complete in <1s instead of dying at timeout
- Tension lifecycle: confirm/dismiss/resolve + injection warnings
- Migrate from mem0/gp-engram/generic JSON: `plur import --from`
- Tiny-tier reranker (ms-marco-MiniLM-L6) + per-store rerank eval gate

### Fixed: installed hook config timed out on every prompt for large stores (#502)

Once a store grows past a few thousand engrams, the CLI cold-start pays ~20s to load the BGE embedder for hybrid injection. The hook config `plur init` installed (sync, `timeout: 15`) meant users eventually hit `UserPromptSubmit hook timed out — output discarded` on **every first prompt** — full cold-start cost paid, zero engrams injected.

- `plur init` now installs `hook-inject` (UserPromptSubmit) and `hook-inject --rehydrate` (PostCompact) with `async: true` and a 90s ceiling. The prompt proceeds immediately; injected context arrives when search completes. **Run `plur init` again after upgrading to migrate an existing install** — init strips and reinstalls its hooks.
- The `--event` hooks (plan_mode / skill / agent / subagent) drop hybrid search and go straight to BM25. They must stay sync — their context has to arrive *before* the tool runs — so they must actually fit their 10s window; hybrid never could on a cold start, so they were killed at timeout on every invocation, burning CPU and injecting nothing. BM25 completes in <1s against a 4k-engram store. First-message injection keeps full hybrid.

### Added

- **Tension lifecycle** (#181, #240): tensions persist with confirm/dismiss/resolve actions and surface as injection warnings; detection is temporal-aware — a genuine contradiction is distinguished from knowledge that merely evolved.
- **Migration importers** (#441): `plur import --from generic|gp-engram|mem0` brings existing memory stores into the engram format.
- **Tiny-tier reranker** (#451): ms-marco-MiniLM-L6 adapter for faster reranking, plus a per-store reranker eval gate that self-checks rerank vs plain RRF and disables reranking where it doesn't help.
- **Lexical query rewriting** (#224): deterministic query expansion for hybrid recall.
- **Injection provenance** (#452): `co_injection` and `injection_outcome` events logged for offline relevance analysis.
- **Scope-routing tuning** (#362): `match_threshold` and `weight_tag` exposed as config.
- **ETL extraction provenance** (#463): convention for `structured_data.extraction` metadata on imported engrams.

### Fixed

- EMBED_DIM contract completed — active-dim column sizing enforced at the storage boundary (#335).
- Async UPDATE/MERGE increments `engram_version`, not `version` (#487).
- MCP array-typed tool arguments hardened against client serialization bugs (#297).
- Reranker pre-flight probe added to the benchmark harness (#341).

## 0.10.0 (2026-06-25)

Security-hardening release, independently audited.

- Engram leak guard hardened
- Pack & sync locked down
- Private-by-default scopes
- Independently re-audited (Črt)
- **Python SDK (`plur-ai`)**: bumped to 0.10.0 — adds `recall_hybrid()` (BM25 + embeddings + RRF), pins npx fallback to CLI 0.10.1

PLUR's engram leak guard, scope isolation, pack/sync distribution, and remote-store trust boundaries were hardened across three internal audit rounds **and an independent adversarial re-audit by Črt** — the Blocker and the full High confidentiality cluster fixed and re-verified, plus every Medium/Low finding. Also lands per-engram scope routing, **private-by-default** visibility, and read-side personal-scope visibility on all three read paths. No breaking API changes; the behavior changes are noted per entry below.

### Security: sensitivity scan window raised to 1 MiB and fail-closed past it (#386)

`detectSensitive()` truncated its input to the first 64 KB before scanning, then silently passed the rest. The infra-topology detectors (`public_ipv4`, `public_ipv6`, `basic_auth_url`, `fqdn_port`, `ipv4_port`, `internal_host`) exist only in `detectSensitive`, so an engram whose first 64 KB was benign filler but which carried a public IP / basic-auth URL / internal host **after** byte 64 KB passed the write guard un-demoted and was written to a shared/remote store (and slipped past `filterPublishable`).

- The scan window is raised from 64 KB to **1 MiB** — far above any realistic engram. The detector regexes are bounded/linear; a benign full-window pass is ~7ms/64KB but adversarial regex-dense input measured ~300–420 ms for a full 1 MiB pass (#386 review). Total scan work is capped at 1 MiB regardless of input size (bounded, linear — a per-write CPU cost on >64KB engrams, not a DoS).
- Input larger than the ceiling is now **fail-closed**: `detectSensitive` appends a synthetic `scan_truncated` hit so `_guardSensitiveScope` demotes the write and `filterPublishable` excludes the engram — the unscanned tail can no longer be assumed clean. The `scan_truncated` signal is always offending regardless of a scope's `sensitivity` policy.
- **Packs export inherits this** (via #389): `scanPrivacy` now routes through `detectSensitive` + `truncateToScanLimit`, so the raised window, the infra-family detectors, and the `scan_truncated` fail-closed all apply to `exportPack`/`installPack` too — the "...and packs" half of #386, delivered by the #389 packs-scan change rather than here.

**Behavior change:** infra/secret content anywhere in the first 1 MiB is now detected and demoted; an engram larger than 1 MiB destined for a shared/remote scope is demoted to `local`/`private` (fail-closed) rather than silently passing.

### Security: `plur sync` never commits secrets or machine-local files (#380, #384)

`plur sync` could commit and push `~/.plur/config.yaml` — which holds remote-store Bearer tokens — to any git remote, because the sync `.gitignore` excluded only derived/cache files and `git add -A` staged everything else. It also ran `git config core.excludesFile /dev/null`, defeating any protective ignore a security-conscious user had configured (#384).

- **Allowlist staging.** Sync now stages *only* the engram-store files (`engrams.yaml`, `episodes.yaml`, `candidates.yaml`, `packs/`, `.gitignore`) via a force-add (`git add -A -f -- <allowlist>`). Secrets (`config.yaml`, `secrets.yaml`) and machine-local derived files (`engrams.db`, `store.pglite/`, `exchange/`) are no longer in the staging pathspec, so they **cannot** ride along regardless of how the user's gitignore is configured.
- **Pack-nested secrets excluded.** Because `packs/` is force-added, a secret *inside* a pack (`packs/<name>/config.yaml`, `secrets.yaml`, `*.token`) would otherwise ride past `.gitignore` — and packs install from untrusted sources. The force-add now carries `:(exclude)packs/**/config.yaml` / `secrets.yaml` / `*.token` pathspecs so those never stage, while the pack's real content still syncs (#387 review).
- **No more global-excludes neutralization.** The `core.excludesFile=/dev/null` call is removed. The force-add on the allowlist preserves the #329 guarantee (engram files stage even when a user's global excludes would ignore them) without stripping the user's protection for everything else.
- **Self-healing.** Sync untracks `config.yaml`/`secrets.yaml` if a vulnerable pre-fix client already committed them, so the next sync stops carrying the secret forward. (Rotating the exposed token and purging git history remain manual operational steps.)
- The sync `.gitignore` now also lists the secret files and `store.pglite/` as defense-in-depth.

**Behavior change:** synced repos created before this fix that contain `config.yaml` will have it untracked on the next `plur sync`. If a token was already pushed to a shared/public remote, rotate it and purge it from history.

### Security: pack secret/PII scan covers the full serialized engram (#381)

`scanPrivacy` ran `detectSecrets` over only `statement + rationale + source`, while `exportPack` serializes the *whole* engram. Any exported-but-unscanned field was a leak: `summary` (formatLayer1), and the caller-supplied `domain`, `tags`, `structured_data`, and `contraindications` all exported with `clean: true`, defeating the "secrets are ALWAYS blocked" export invariant.

- **Secret/PII scan is now serialize-based.** `scanPrivacy` scans the *serialized engram payload* (every caller-settable field, including future additions) for secrets, personal paths, emails, and private IPs — not a hand-maintained field list, which is the same enumerate-vs-serialize drift that caused the bug. Fields `exportPack` strips (`relations`/`associations`/`knowledge_anchors`) and internal/numeric bookkeeping are excluded so they don't cause false rejections; PLUR-internal `_`-prefixed `structured_data` keys are dropped. `installPack` blocks and `exportPack` filters an engram with a secret in any scanned field.
- **Infra family is now scanned (review fix).** The serialized scan uses `detectSensitive` (a superset of `detectSecrets`), so public IPv4/IPv6, internal hosts, basic-auth URLs and host:port topology — the 2026-06 infra-leak class — are blocked on pack export/install, not just API-key-shaped secrets. The previous `detectSecrets` gate missed all of these, so an infra leak in `summary`/`tags`/`source` exported clean.
- **ReDoS guard (review fix).** The serialized scan input is capped (`truncateToScanLimit`, 64 KB) before any regex runs, and the email matcher now uses bounded quantifiers. Uncapped, an attacker-authored engram with a long dotted run after `@` made the email regex backtrack ~8–17s, hanging `previewPack`/`installPack`/`exportPack`.
- **Prompt-injection scan stays field-based** (`statement + rationale + source + summary + domain`) — only fields rendered into agent context can carry an effective injection, and scanning arbitrary metadata would add false positives.
- `learn()` / `learnRouted()` now secret-scan the caller-supplied `domain`, `tags`, and `abstract` (not just `statement`) when `allow_secrets` is false, rejecting a secret in any of them at write time.

**Behavior change:** a pack engram carrying a secret in any exported field (`summary`/`domain`/`tags`/`structured_data`/`contraindications`/…) is now blocked on install / filtered on export; a `learn` with a secret in `domain`/`tags`/`abstract` throws unless `allow_secrets` is set.

### Security: scope auto-registration refuses personal-family scopes from `/me` (#382)

`registerDiscoveredScopes()` registered **every** scope a server returned from `GET /api/v1/me` as a writable remote store, with no shared-scope check. A compromised or MITM'd endpoint could return `scopes: ['global', 'user:<victim>', 'local']`; registering `global` (the default unscoped routing fallback) as a writable remote store would route every later default/unscoped `learn` to the attacker's server.

- `registerDiscoveredScopes()` now filters `/me`-advertised scopes through `isSharedScope()` before `addStore`: only shared-family scopes (`group:`/`project:`/`space:`/`team:`/`org:`/`public`) are auto-registered. Personal-family scopes (`global`/`local`/`user:*`/`agent:*`) are refused, logged, and returned in a new `skipped` field on `RegisterDiscoveredResult`. The CLI (`plur stores discover --register`) and MCP (`plur_scopes_discover`) surface the skipped scopes.
- A genuine remote-backed personal scope (e.g. a `user:` scope on your own server) must be added deliberately via `plur stores add`; it is never auto-registered from untrusted server input.

**Behavior change:** `plur_scopes_discover register:true` / `plur stores discover --register` no longer register personal-family scopes a server advertises — they are reported as `skipped`.

### Security: segment-aware scope membership — no sibling-prefix bleed (#383)

The read-side scope filters and store-load gates decided shared-scope membership with a bare string-prefix test (`scope.startsWith(query)` / `LIKE query || '%'`) and no delimiter boundary. A shared scope that is a string-prefix of a sibling leaked across the isolation boundary: a `project:app` recall/inject/list surfaced `project:application` and `project:app-secret`; a `group:plur/eng` query surfaced `group:plur/eng-private`.

- New `isScopeWithin(scope, queryScope)` predicate in `scope-util.ts` matches a scope iff it is exactly equal or a descendant separated by a real delimiter (`:` or `/`) — so `project:app:sub` and `project:app/x` still match, but `project:application` does not.
- Applied at all read paths and store-load gates: non-indexed recall (`index.ts`), indexed SQLite `loadFiltered` + reindex gate (`storage-indexed.ts`), PGLite `buildFilterClause` (`storage-pglite.ts`), inject `scoreEngram` (`inject.ts`), and the in-memory store gate (`index.ts`). SQL paths use `scope = ? OR scope LIKE ?||':%' OR scope LIKE ?||'/%'`.
- The personal-family pass-through (`isPersonalScope`) is unchanged — personal scopes still surface under a project-scope recall.

**Behavior change:** an engram in a shared scope that is merely a string-prefix of the query scope is no longer returned by recall/inject/list. True descendants (delimiter-separated) are unaffected.

### Security: full audit remediation — Medium/Low cluster + independent re-audit (#387–#429)

Beyond the Blocker/High items above, the complete audit set was remediated and independently re-verified:

- **Scope routing & visibility:** keyword-only over-routing capped so a generic memory can't auto-file into a team store; equal-confidence domain ties resolve by coverage specificity; `public`-prefixed scopes no longer misclassified as shared; the pglite backend passes all personal-family scopes on a project recall; dedup demote now scans merged tags; the dead engram-publish filter removed.
- **Distribution & packs:** `exportPack` excludes every privacy-flagged engram (PII/injection, not just secrets); the agent keystore plus a pack-content **allowlist** close the sync leak surface; the pack scan is fail-closed past 1 MiB.
- **Remote-store trust:** driver cache invalidates on token rotation; server-assigned ids are shape-validated; `/me` scope names are validated at the trust boundary (non-string + injection-name); per-scope registration is isolated; malformed-row logs are sanitized; `stores add` reports honestly when a path drops a scope.
- Verified by the full test suite (2000+ tests), a 287-case adversarial fuzzer suite, our own pre-handoff adversarial audit, and **Črt's independent re-audit (HOLD → cleared)**.

### Leak guard: write-time demotion now covers `saveMetaEngrams` and remote-backed scopes (#368, #370)

The sensitivity leak guard — which detects secrets/infra patterns in an engram and demotes a shared-scope write to `local`/`private` before it can reach a shared store — now runs on more write paths:

- **`saveMetaEngrams` is guarded (#368).** Meta-engrams (abstractions, summaries) created on the save path now pass through the same `_guardSensitiveScope` check and context-field scan (`rationale`/`source`/`snippet`/`dual_coding`) as ordinary learns. A meta-engram carrying a secret in its statement *or* its context fields is demoted, and the demotion is **surfaced** to the caller (no longer silent) — the CLI/MCP display a "held back from shared scope" warning.
- **Remote-backed personal scopes are covered (#370).** The guard now demotes sensitive content destined for any **remote-backed** scope, including `user:*` family scopes that resolve to a remote store — not just `group:`/`project:`/`space:` team scopes. Closes the gap where a remote-backed personal scope could receive un-demoted sensitive content.

**Behavior change:** writes (including meta-engram saves) whose statement or context fields match a secret/infra pattern are demoted to `local`/`private` and the demotion is reported. Re-scope deliberately if a match is a false positive.

### Routing recalibration: unscoped default = `global`, deterministic domain-prefix routing, readonly scopes excluded (#367, #369)

The unscoped-write routing introduced for per-engram scoping is recalibrated:

- **`WEIGHT_DOMAIN` raised 1.0 → 1.5 and readonly scopes excluded from auto-route (#367).** Domain-channel matches carry more weight when scoring candidate scopes, and read-only stores are no longer eligible auto-route destinations (a write can't land where it can't be written).
- **Deterministic routing on a full domain-prefix match (#369).** When a genuinely-unscoped write's `domain` is at least as specific as a writable scope's declared `covers` namespace, it auto-routes to that scope deterministically (no edge-of-threshold flakiness). The default for a write with no matching cover remains `global`.

**Behavior change:** an unscoped `plur learn` (no `--scope`) defaults to `global` and may **auto-route to a writable team scope** when its `domain` matches that scope's `covers`. This is the same path the CLI, MCP, OpenClaw, and Hermes (as of this release) all reach — Hermes no longer forces `--scope global` and so participates in auto-routing.

### Detector quality: INTERNAL_HOST two-pass detection, `basic_auth` recategorized infra → secrets, 64 KB scan cap (#364)

- INTERNAL_HOST detection is a two-pass match (candidate match + false-positive gate) so benign config-file names (`config.local`, `data-staging.csv`) don't suppress a real internal host elsewhere in the same text, and host-shaped tokens in ordinary prose are detected.
- `basic_auth_url` is recategorized from `infra` to `secrets` (a HARD family) so a credential-bearing URL triggers write-time demotion under the default `allow_secrets:false` policy.
- The sensitivity scan is capped at 64 KB of input per engram to bound worst-case scan cost on pathologically large content.

**Behavior change:** more internal-host and credential-URL content is now detected and demoted; very large engram bodies are scanned up to a 64 KB cap.

### Config robustness: stores writeback passthrough preserves `url`/`token` across version skew (#365)

`persistStores` / `mergeStoresForWriteback` now pass unknown nested `sensitivity` fields through on writeback, so an older PLUR writing back a config authored by a newer PLUR no longer strips a store entry's forward-compat metadata — the store's `url`/`token` survive a load → persist round-trip even when the `sensitivity` block carries fields this version doesn't recognize.

**Behavior change:** remote-store `url`/`token` are preserved across a config round-trip under version skew (previously a malformed/forward-compat `sensitivity` block could drop the entry).

### Un-scoped write default reverted to `global` + read-side personal-scope visibility on all 3 paths (#353)

The Stage 3b un-scoped WRITE default (`local`) is reverted to `global` (the historical default). The revert alone was insufficient: the read-side scope filters hardcoded a `global`-only personal pass-through and DROPPED other personal-family scopes (`local`, `user:*`, `agent:*`) under a project-scoped recall/inject. This PR fixes the read side on **all three read paths** — inject `scoreEngram`, the non-indexed recall filter, and the DEFAULT indexed SQLite path (`storage-indexed.ts`, via a new `personal` column) — using the authoritative predicate `isPersonalScope(scope) = !isSharedScope(scope)`, not a hardcoded `{local,global}` set.

**Intended read-visibility surface change (not a leak):** Engrams at `scope=local` (including those written during the Stage 3b period) and any `scope=local` / `user:*` engrams now appear in project-scoped sessions after this fix, consistent with non-shared scopes being personal-family. Personal scopes never reach team shared stores; only an explicit shared scope (`group:`/`project:`/`space:`/`team:`/`org:`/`public`) does.

**RECALL/INJECT asymmetry (intentional, kept):** an explicit `scope=global` RECALL returns ALL personal-family engrams, but an explicit `scope=global` INJECT returns ONLY global-scoped engrams (targeted global-namespace injection, encoded by `INJECT_GLOBAL_IS_TARGETED`). The `plur_recall` tool description and `plur_session_start` guidance note this.

**Note:** Users with `unscoped_default: local` should be aware that cross-scope recurrence promotion currently ignores `unscoped_default` and promotes to `global` on the 2nd cross-scope hit (tracked as Stage 3b v2, see `docs/KNOWN_ISSUES.md`).

**Cross-surface consistency:** the CLI `plur learn` now omits the scope key when `--scope` is absent (flowing through unscoped routing via `learnRouted`) and the OpenClaw `_learnIfNew` routes via `learnRouted` (so shared-scope auto-learns reach their remote store); both pass `undefined` rather than a hardcoded `global` for unscoped sessions. The MCP `scope_hint` now fires on any non-shared landing scope (`isSharedScope` swap).

The module cycle that this required (inject.ts needing `isPersonalScope` from index.ts) is broken by moving the scope-family predicates to a new leaf module `scope-util.ts`; `@plur-ai/core` re-exports `isSharedScope`/`isPersonalScope` unchanged.

### Security hardening: pack install, remote-store, learnBatch (#306)

Addresses the 2026-06-10 security audit of `@plur-ai/core`:

- **Pack install** now clamps host-overriding fields before pack engrams can reach injection: `pinned` is stripped and `commitment: locked` is downgraded to `decided` (the on-disk pack and its integrity hash reflect the sanitized content). `scanPrivacy` detects prompt-injection / instruction-override text across **every field rendered into agent context** — `statement`, `rationale`, `source`, and `summary` — and `installPack` blocks on it unless `allowInjection: true` is passed. `previewPack` surfaces pinned/injection counts. `visibility: private` engrams no longer skip the scan (they are still installed and injected, so they must be scanned).
- **Pack export** strips `pinned` and locked `commitment` from exported engrams — never ship an always-load directive in a shareable pack.
- **Remote store** validates every server row against `RemoteRowSchema` (lenient, `.passthrough()`) in `load`/`getById`/`patch`; malformed rows are dropped and logged instead of cast with `as unknown as Engram`. Authoritative `id`/`scope`/`status` columns win over `data`. Fields rendered into agent context or used in arithmetic (`confidence_score`, `rationale`, `summary`, `domain`) are type-checked; explicit nulls pass. Verified against all production rows on both enterprise servers (137/137 pass).
- **`learnBatch`** caps LLM dedup calls per batch (default **50**, `maxLlmCalls` option, `Infinity` to opt out); once spent, remaining statements fall back to the hash/cosine path. Bounds bulk-import cost.
- **CI governance**: `.github/CODEOWNERS` covers workflows and `release.sh`. Note: only enforced once branch protection enables "Require review from Code Owners".

**Behavior changes:** `installPack` can now throw on injection-flagged packs (override with `allowInjection`); bulk imports of >50 novel statements use cheaper dedup for the remainder; remote rows failing validation are dropped (previously passed through unvalidated).

### `@plur-ai/core` exports the embedding primitive (#289)

`embed()`, `EMBED_DIM`, `embedderStatus()`, and `cosineSimilarity()` are now part of `@plur-ai/core`'s public API. Previously only the `SimilarityResult` type was re-exported, so the local BGE embedder (`BAAI/bge-small-en-v1.5`, 384-dim) was effectively internal. Alternative store backends that persist vectors and run similarity in a database can now compute embeddings identically to core's hybrid search instead of re-implementing the embedder and risking model/dimension drift.

```ts
import { embed, EMBED_DIM } from '@plur-ai/core'
```

- `EMBED_DIM` (384) is a new named constant. `embed()` asserts its first successful output against it once per process, so a model swap that changes the dimension fails loudly instead of silently corrupting persisted vectors.
- **Breaking-change contract:** the embedding model identity and `EMBED_DIM` are a stable public contract. Changing either is a breaking change for any consumer that persists vectors — they must re-embed. Treat a model/dimension change accordingly.

No new model and no external dependency — this only makes the existing capability reusable.

### `plur_stores_add` no longer silently drops additional scopes for the same remote URL (#291)

A user authorized for several team scopes on one enterprise instance could only ever register the **first** one. `addStore()` deduplicated remote stores by **URL only**, so a second scope for an already-registered URL hit an early `return` — persisting nothing — while the MCP tool still reported `success: true`. The misleading success masked the failure, and because reads are server-scope-filtered (`?scope=` per store), the user silently lost access to every team beyond the first.

- **`packages/core/src/index.ts`** — remote stores now deduplicate by **url + scope**, so one URL can host N scopes. Local stores keep **path-only** identity: one `engrams.yaml` is one store — the loader clones global-scoped engrams into each entry's scope, so a second scope on the same file would double-load them. `addStore()` returns `{ status: 'added' | 'already_registered' | 'overwritten', scope }` instead of `void` (on `already_registered`, `scope` is the existing entry's — for local stores it may differ from the request). The existing scope-conflict guard — a *different* endpoint claiming the same scope — is unchanged.
- **`packages/mcp/src/tools.ts`** — `plur_stores_add` surfaces `status` and only claims `success: true` when a scope genuinely persisted. Description notes that one remote URL can host multiple scopes.
- **`packages/cli/src/commands/stores.ts`** — `plur stores add` prints the real outcome (added / already registered / reassigned).

Token rotation is intentionally out of scope: re-adding the same URL+scope with a different token stays an `already_registered` no-op rather than silently swapping the stored token.

### Client scope discovery — find & register all authorized scopes (#292)

The client never asked the enterprise server which scopes a token can access, so a user authorized for N teams had to discover scopes out-of-band and hand-register each. The server already exposes the full resolved scope set at `GET /api/v1/me`; this wires the client to it. (Builds on #291 — registering N scopes under one URL is what makes auto-register meaningful.)

- **`packages/core/src/store/remote-store.ts`** — new `RemoteStore.me()` calls `GET /api/v1/me` and returns the resolved identity + authorized scopes.
- **`packages/core/src/index.ts`** — `discoverRemoteScopes()` reports, per configured remote URL, the authorized scopes split into `registered` vs `unregistered` (read-only, per-URL timeout, failures captured not thrown). `registerDiscoveredScopes()` registers every authorized-but-unregistered scope in one step.
- **`packages/mcp/src/tools.ts`** — new `plur_scopes_discover` tool (read-only by default; `register: true` registers all). `plur_session_start` now surfaces a best-effort hint when the token is authorized for scopes that aren't registered yet — bounded by a short timeout and fully swallowed on error, so it never blocks or slows session start.
- **`packages/cli/src/commands/stores.ts`** — new `plur stores discover [--register]`.

One token → discover all authorized team scopes → register them in one action.

### Surface remote-store auth failures instead of failing silently (#295)

When an enterprise token expired, the client failed silently: team-scoped writes 401'd and queued to the local outbox, reads returned 0, and `plur_doctor` still reported "healthy". The only way the gap surfaced was a human noticing no new engrams. This makes the failure legible.

- **`packages/core/src/jwt.ts`** (new) — `decodeJwtExpiry()` reads a token's `exp` claim (no signature verification) so the client can warn before/after expiry. Opaque (non-JWT) keys return all-null and callers fall back to the live probe.
- **`packages/core/src/index.ts`** — `checkRemoteHealth()` probes `GET /api/v1/me` per configured remote (raced against a timeout) and combines it with the JWT-expiry read, classifying each endpoint as `ok` / `auth_expired` / `unreachable`. `remoteTokenExpiries()` is a local-only (no network) expiry read for the fast session-start path. `learnRouted()` now flags `_outbox.auth_failed` when a remote write fails with 401/403, so a queued engram is distinguishable from a transient network blip.
- **`packages/mcp/src/tools.ts`** — `plur_doctor` adds a per-remote check (reachable / auth-expired / unreachable + "expires in N days"), so it no longer reports "healthy" when the remote auth is dead, with reauth remediation. `plur_session_start` surfaces a loud guide warning when discovery hits a 401/unreachable (reusing the discovery probe — no extra round-trip) and a proactive "token expires in N days" warning from the local JWT read.

The reauth command itself (`plur login`) and longer-lived keys are tracked separately as a fast-follow.

### Teach per-engram scope selection so team knowledge stops defaulting to global (#296)

Per-engram scoping was supported (every `plur_learn` takes a `scope`) but nothing taught agents to use it, so they routinely omitted `scope` → it fell back to `global` → team-relevant knowledge silently never reached the configured group store. This affects any install with a remote/group store. The capability worked; the guidance and the defaults didn't. Fixed at three layers — always-on instructions, install-time guidance, and a runtime safety net:

- **`packages/mcp/src/server.ts`** — the server `INSTRUCTIONS` block (advertised to every client on connect) gains a single "SCOPE SELECTION" section: scope is content-driven and per-call; team/shared knowledge → the matching `group:<org>/<team>` scope (`plur_session_start` lists the writable ones); personal/local → default; never let team knowledge fall back to `global`. Exported for testing.
- **`packages/cli/src/commands/init.ts`** (+ repo `CLAUDE.md`, `README.md`) — the CLAUDE.md `plur init` generates replaces the thin "Multi-project scoping" note with a fuller "Scope selection (set scope PER engram, by content)" guide enumerating the team / project / personal routing and the global-fallback anti-pattern.
- **`packages/mcp/src/tools.ts`** — runtime safety net: when a `plur_learn` call omits `scope`, lands at `global`, **and** a team store is configured, the response carries a non-fatal `scope_hint` naming the writable team scopes (silent on personal installs). `plur_session_start` guidance is also made prescriptive about per-engram routing.

`plur_session_start` already surfaces the live writable remote scopes (#229); this adds the always-on, install-time, and at-write-time guidance around it. Relates to #291 (a comms/second scope can't be registered against the same URL until that lands) and #295 (silent auth-expiry). Consolidates #299 (install surfaces) and #324 (runtime).

## 0.9.11 (2026-05-26)

Bug sweep — three independent fixes bundled.

### `plur_session_end` no longer crashes on string-array suggestions (#231)

Calling `plur_session_end` with `engram_suggestions: ["a", "b"]` (bare strings rather than `{statement, type}` objects) used to crash with the cryptic `Cannot read properties of undefined (reading 'match')`. The MCP JSON-Schema→Zod converter ignored nested `items` shape, the handler dereferenced `s.statement` on a string, and `detectSecrets()` exploded inside `plur.learn` with no context. Fixed at every layer:

- **`packages/mcp/src/server.ts`** — schema-to-Zod converter now recurses into array `items` and supports `anyOf`/`oneOf` via `z.union`.
- **`packages/mcp/src/tools.ts`** — `engram_suggestions` schema declares `items` as `anyOf: [string, object]`. Handler coerces bare strings into `{statement: s}` (LLM-friendly recovery) and throws a clear error for non-string non-object items.
- **`packages/core/src/secrets.ts`** + **`packages/core/src/index.ts`** — `detectSecrets()` and `plur.learn()` throw clear `TypeError` when called with non-strings, instead of letting `undefined.match()` propagate.

### `plur_stores_list` reports accurate remote engram counts (#184)

`plur_stores_list` used to return `engram_count: 0` for remote stores on the first call of a fresh MCP server session because `_loadRemoteCached` is synchronous and returns whatever's in the driver cache (empty on first call) while triggering an async load in the background. New `Plur.listStoresAsync()` awaits each remote driver's `load()` with a per-store 5-second timeout race so a hung remote can never block the listing call. The MCP `plur_stores_list` handler and the `plur stores list` CLI command both call the async variant. Sync `listStores()` is retained with `@deprecated` for callers that cannot await.

### `plur doctor` exits cleanly even when the embedder crashes (#197)

`onnxruntime-node` has a known SIGABRT crash on macOS during libc++ thread-pool cleanup on process exit, which caused `plur doctor` itself to exit with code 134 even when everything else was healthy. The embedder probe now runs in an isolated subprocess (`plur _embedder-probe`, an internal subcommand guarded by `PLUR_INTERNAL_PROBE=1`) — if it crashes, only the subprocess dies and the doctor reports `embedder: degraded` with the parent's exit code intact. Handles compiled binaries (pkg, bun --compile, nexe) gracefully by skipping the probe when the CLI entry isn't a JS file.

### Tests

11 new tests across `packages/core/test/secrets.test.ts`, `packages/core/test/remote-store-cache.test.ts`, `packages/mcp/test/server.test.ts`, `packages/mcp/test/session.test.ts`, and `packages/cli/test/embedder-probe.test.ts`. Full suite: 1045 passed, 19 skipped.

### Packages bumped

- `@plur-ai/core`: 0.9.10 → 0.9.11
- `@plur-ai/mcp`: 0.9.10 → 0.9.11
- `@plur-ai/cli`: 0.9.10 → 0.9.11
- `@plur-ai/claw`: unchanged (no claw-side changes)

## 0.9.9 (2026-05-14)

Concurrent writes — hardened.

- Multi-agent writes serialize cleanly
- Failed saves logged, not silent
- Pipelines auto-resume mid-run
- Jittered retries bound wall time

### What changed (Hermes plugin)

When two agents write engrams at the same time — a Twitter cron and a Telegram bot, say — they can race for the engram-store lock. Before 0.9.9, the second writer's call would fail silently and the engram would be lost. 0.9.9 retries lock-contended writes with jittered exponential backoff, surfaces typed `PlurLockError` exceptions for callers that want to react, and bounds wall-time exposure via a circuit breaker.

The meta-extraction pipeline now preserves recovery state on partial failure — if 3 of 10 saves fail mid-run, the failed three are retained and can be retried via an empty-body resubmit (caller doesn't have to re-run the full 6-stage pipeline).

### Improvements

- **Layered retry**: outer layer handles CLI hangs (TimeoutExpired → graceful safe-fallback after 5/15/30s backoff). Inner layer handles lock contention (PlurLockError → jittered 1/2/4s backoff). Both honor `PLUR_BRIDGE_RETRY=false`.
- **`PlurLockError`** — new typed exception (subclass of `PlurBridgeError`) so callers can distinguish transient lock contention from permanent errors. Backwards compatible: existing `except PlurBridgeError` still catches it.
- **Jitter** (±50% on each retry delay) defeats thundering-herd phase-lock between concurrent bridge instances.
- **Failed engram saves** in the meta-pipeline are now logged at WARNING with `exc_info=True` instead of silently swallowed by `except: pass`. The response surfaces `saved` / `failed` / `skipped` / `failed_engrams` counts.
- **Stage-5 retry path** in `submit_analysis`: after a partial save failure, the pipeline state is preserved with only the failed engrams. Resubmit with `submit_analysis(session_id, [])` to retry exactly those — no need to re-run the full pipeline.
- **Crash-resume guidance**: `start_extraction` on a stage-5 retry-pending session returns `status: "retry_pending"` with explicit instructions instead of confusing `status: "resuming"` with empty prompts.
- **Circuit breaker** in `_save_and_finalize` (3 consecutive failures → defer remaining engrams) bounds wall time on sustained contention. Prevents N × bridge-timeout blocking when the engram store is unreachable.
- **JSON error message extraction** unwraps `{"error": "..."}` from `--json` CLI output authoritatively, suppressing npm/Node stderr noise from leaking into user-facing exception messages.

### Internal

- New `_call_with_lock_retry()` helper extracts the inner retry; `_invoke_cli()` is the single CLI invocation that propagates `TimeoutExpired` / `FileNotFoundError` to the outer layer and raises `PlurLockError` / `PlurBridgeError` for callers.
- `_is_lock_failure()` regex covers 3 phrasings — survives minor wording changes in core's `withLock` / `withAsyncLock` messages.
- 38 net-new tests (42 → 88 total) covering retry boundaries, jitter bounds, JSON-envelope edge cases (null/empty/malformed/array), circuit breaker, multi-round retry, stderr-noise scenarios, `_save_state` failure path, None-responses guard, bytecode-level `-O` safety.
- 4 evaluator audit iterations (critic ×4, dijkstra ×2, data ×3). Final critic verdict: ready to merge.

### Versions

- `@plur-ai/core` 0.9.8 → 0.9.9
- `@plur-ai/mcp` 0.9.8 → 0.9.9
- `@plur-ai/cli` 0.9.4 → 0.9.9
- `plur-hermes` 0.9.4 → 0.9.9

### Deferred to follow-up

- Core-side `withLock` retry-budget bump (needs configurable per-consumer defaults, not a global change).
- `_find_duplicate` swallows `PlurLockError` silently — pre-existing, results in one extra CLI call under contention, not data loss.

## 0.9.8 (2026-05-06)

`plur_learn` with a remote scope now returns the **server-canonical
engram id** so a later `plur_forget(id)` / `plur_feedback(id)` actually
finds the engram.

### Fixes

- **New `Plur.learnRouted(statement, context)` async method** — for remote-scope writes, awaits the POST to `/api/v1/engrams` and returns an Engram with the server-assigned id (e.g. `ENG-2026-05-06-008`). For local-scope writes, defers to sync `learn()` so dedup behavior is unchanged.
- **`RemoteStore.appendAndGetServerId(engram)`** — companion to `append()` that returns `{ id }` parsed from the server's response. The existing `append()` keeps its `Promise<void>` shape to satisfy the `EngramStore` interface contract; the new method is for callers that need the canonical id.
- **MCP `plur_learn` handler routes through `learnRouted` first** — was using `learnAsync` (LLM-driven dedup) which ultimately called sync `learn()` and returned the local placeholder id. Users saw e.g. `ENG-2026-0506-017`, then `plur_forget("ENG-2026-0506-017")` returned "Engram not found" because the engram only existed on the server with id `ENG-2026-05-06-008`.
- **Loud failure on remote-write failure** — `learnRouted` throws when the POST fails (network, 5xx). The MCP handler catches and falls back to sync `learn()`, returning the local placeholder id with a `warning` field naming the trade-off so the caller can react instead of silently believing the write succeeded.

### Verification (against production)

Verified end-to-end before publish:
1. `plur.learnRouted(stmt, { scope: 'group:plur/plur-ai/engineering' })` returned `ENG-2026-05-06-008` (server format `^ENG-\d{4}-\d{2}-\d{2}-\d{3}$`)
2. `GET /api/v1/engrams/ENG-2026-05-06-008` returned 200 with the same statement → roundtrip works

All 806 tests pass.

### Versions

- `@plur-ai/core` 0.9.7 → 0.9.8
- `@plur-ai/mcp` 0.9.7 → 0.9.8
- `@plur-ai/claw` 0.9.13 → 0.9.14

### Why this matters

0.9.7 fixed routing-to-remote and the silent config clobber. But the engram object returned to the caller still had the *local* placeholder id — meaning that any code holding onto that id (to pass to `forget`, `feedback`, or `history`) had a phantom reference. Users would write a team engram, copy the id, try to retire it, and get "Engram not found" — even though the write succeeded on the server. 0.9.8 closes the id-roundtrip loop so the value the caller gets back is the value they can use.

## 0.9.7 (2026-05-06)

`loadConfig` no longer drops the entire `stores` array on a single bad
entry. Closes the silent-clobber pathway that made the 0.9.6 fix hard
to land.

### Fixes

- **Per-entry tolerance in `loadConfig`** — previously `loadConfig` parsed the entire config with `PlurConfigSchema.parse()`. Any single invalid `stores` entry threw, and the catch returned an empty config (`{}`), silently dropping every other valid entry too. In the wild this meant a pre-0.9.5 MCP process running against a 0.9.6+ config (which has `url`-based remote stores its old schema doesn't know about) would: load → throw → fall back to empty → save back over the file → permanently lose the user's remote store registration. Now each store entry is validated independently with `safeParse`; invalid entries are dropped with a `[plur:config] dropping invalid stores[N] (label) ...` warning, valid entries survive.
- **Loud failure on top-level config parse errors** — when `loadConfig` falls back to defaults due to YAML or schema issues at the top level, it now logs the path and the error reason. Silent fall-back was the worst kind of failure mode.

### End-to-end verification (production)

This release was verified against `https://plur.datafund.io` before publish:
1. Config with mixed valid (URL+token) and invalid entries → only the invalid entry dropped, URL store survived
2. `plur.learn(stmt, { scope: 'group:plur/plur-ai/engineering' })` → POSTed to `/api/v1/engrams`, returned server-assigned ID
3. REST GET on the new ID → confirmed engram on server with correct scope
4. Local `engrams.yaml` not created → no leak

All 516 core tests pass.

### Versions

- `@plur-ai/core` 0.9.6 → 0.9.7
- `@plur-ai/mcp` 0.9.6 → 0.9.7
- `@plur-ai/claw` 0.9.12 → 0.9.13

### Why this matters

0.9.6 shipped the `learn()` routing fix for plur-ai/enterprise#25 but in practice teams couldn't observe it: any pre-0.9.5 MCP instance still running on the same machine would clobber the config file on each load/save cycle, dropping the URL store entry. 0.9.7 removes that pathway — even an old client behaving badly can no longer take down the whole stores array.

## 0.9.6 (2026-05-06)

`plur_learn` now actually writes to remote stores. Closes the half-shipped
RemoteStore work from 0.9.5.

### Fixes

- **`learn()` routes writes to matching remote stores** ([plur-ai/enterprise#25](https://github.com/plur-ai/enterprise/issues/25)) — when an engram's scope matches a registered remote store entry (writable, exact-scope match), the engram is POSTed to that store's `/api/v1/engrams` endpoint instead of being written to the local YAML. 0.9.5 shipped registration (`plur_stores_add`) and remote reads (`RemoteStore.load()`) but missed the write routing — engrams with team scopes silently stayed local. The Datafund pilot's entire shared-memory value prop was broken until this fix.
- Routing is **fire-and-forget for the sync path** — `learn()` returns the engram object immediately and the network append completes in the background. Failures log loudly via `[plur:learn] remote append failed for ...`. The proper outbox pattern (queue + retry + reconcile) is tracked in [plur-ai/enterprise#26](https://github.com/plur-ai/enterprise/issues/26).
- Match rule (pilot scope): exact-match `entry.scope === engram.scope`. Prefix-match deferred — narrower scopes need explicit registration. Keeps routing predictable, prevents accidental cross-team writes.
- Read-only remote entries (`readonly: true`) keep writes local — same as filesystem stores.

### Versions

- `@plur-ai/core` 0.9.5 → 0.9.6
- `@plur-ai/mcp` 0.9.5 → 0.9.6
- `@plur-ai/claw` 0.9.11 → 0.9.12

### Migration

If you followed the onboarding for 0.9.5 and `plur_learn` with a team scope wrote locally — those engrams need to be re-published. There's no auto-sync. Either:
- Manual: read each affected engram from local YAML, call `plur_learn` again with the same statement+scope (now-fixed routing sends it to the server)
- Wait for #26 (outbox pattern) which will reconcile pending local writes against the remote on next session start

## 0.9.5 (2026-05-05)

Remote stores — register PLUR Enterprise (or any compatible REST endpoint) as a store via `plur_stores_add`.

### Features

- **`RemoteStore` driver** in `@plur-ai/core` — implements the same `EngramStore` interface as `YamlStore`/`SqliteStore` but reads/writes against an HTTP endpoint (PLUR Enterprise's `/api/v1`). 60s TTL cache, in-flight request dedup, paginated load, never-throws on network failure.
- **`plur_stores_add` accepts `url`+`token`** — was `{path, scope}`-only; now `{path | url+token, scope}`. Schema requires exactly one of path/url. Backwards compatible: existing filesystem-store call sites unchanged.
- **`StoreEntry` config schema** — adds optional `url` and `token` fields, refine() enforces exactly-one-of-path-or-url.
- **`Plur.addStore()`** — accepts `options.url` and `options.token` to register remote stores. `Plur.listStores()` returns `{path?, url?, scope, ...}` shape.
- **MCP `plur_stores_add` tool** — `required: ['scope']` (was `['path', 'scope']`). Returns `kind: 'filesystem' | 'remote'`.

### Why this matters

The PLUR Enterprise pilot needed a clean answer to "what does an existing local-PLUR user do?" The previous answer was "configure two MCP servers in `mcp.json` and prefix every call with `plur-local__` or `plur-enterprise__`." The new answer is `plur_stores_add url=... token=... scope=...`, registered once on the existing single-MCP-server install. Existing multi-store recall machinery handles the merge.

## 0.9.4 (2026-05-04)

Hybrid recall, restored.

- BGE embeddings actually work
- Pinned engrams (always-inject)
- plur_doctor diagnostic
- PLUR_DISABLE_EMBEDDINGS opt-out

### Fixes

- **Hybrid search degraded-mode surfacing** — `plur_recall_hybrid` now reports `mode: 'hybrid-degraded'` (with the underlying error) when the embedding model failed to load. Previously it lied with `mode: 'hybrid'` while silently falling back to BM25-only.
- **Embeddings build config** — `@huggingface/transformers`, `onnxruntime-node`, `onnxruntime-web`, `sharp`, `@huggingface/jinja` now marked external in the core tsup config. Bundling them broke ONNX backend registration in production with "listSupportedBackends is not a function".
- **Embedder retry** — `getEmbedder()` no longer latches the first-load failure forever. Each call re-attempts so first-run download races resolve themselves.
- **Embedding boost uses cosine, not rank** — `injectHybrid` previously gave the top semantic result a hardcoded boost of 1.0 regardless of how unrelated it was. Now uses the actual cosine score so the threshold is meaningful.
- **Embedding threshold raised 0.3 → 0.5** — the lower threshold was tuned for a non-functional embedder. Once BGE actually loaded, 0.3 surfaced spurious matches between unrelated short English sentences.
- **Pinned engrams bypass minRelevance filter** — without this, sessions with strong unpinned matches would silently drop pinned engrams (the entire pinning contract failed). Pinned engrams are also now sub-capped at 50% of the token budget so they can't starve relevance-scored engrams when many pinned packs are installed.
- **`plur init` upgrades stale packs** — was name-only (existing installs missed new pack content); now compares manifest versions and reinstalls when bundled > installed. Versionless packs are upgraded unconditionally.

### Features

- **`plur_doctor` MCP tool + extended `plur doctor` CLI** — probes embedder availability, reports the actual load error, and lists remediation steps including the corrupt-cache recovery path. Use this first when recall feels off.
- **Pinned engrams** (`pinned: true` on the schema) — bypass the keyword-relevance gate in `scoreEngram`, the per-pack/per-domain caps in `fillTokenBudget`, and the minRelevance filter. Use sparingly — meta-rules and safety conventions only.
- **`plur_pin` MCP tool + `pinned` param on `plur_learn`** — toggle and create pinned engrams.
- **API additions**: `Plur.setPinned(id, bool)`, `Plur.listPinned()`, `Plur.embedderStatus()`, `Plur.resetEmbedder()`, `Plur.recallHybridWithMeta()`.
- **Embeddings opt-out** — `PLUR_DISABLE_EMBEDDINGS=1` env var (also accepts `true`, `yes`) or `embeddings.enabled: false` in `~/.plur/config.yaml`. Doctor distinguishes "disabled by design" from "embedder broken." Hybrid recall reports the new `mode: 'bm25-only'` when opted out.
- **Three-way mode reporting on hybrid search** — `mode: 'hybrid' | 'hybrid-degraded' | 'bm25-only'`. `bm25-only` is the new "by design" state; `hybrid-degraded` is reserved for actual embedder load failures.

### Hardware footprint

0.9.4 makes embeddings actually work. First `plur_recall_hybrid` after upgrade triggers a one-time **~130MB BGE model download** (Xenova/bge-small-en-v1.5) plus ONNX runtime load (~few hundred MB RAM while resident, a few seconds first-call latency). Subsequent calls are fast. **Opt out** for low-resource or strict-offline environments via `PLUR_DISABLE_EMBEDDINGS=1` or `embeddings.enabled: false` in `~/.plur/config.yaml`.

### Knowledge pack consolidated

`effective-memory` v1.0.0 (8 engrams) → **v1.1.0 (12 engrams, all pinned)**. Merged the meta-rules from the standalone `plur-required` pack into the canonical `effective-memory` pack so users get one essential pack, pinned, with examples and analogies preserved. Existing 0.9.2/0.9.3 installs auto-upgrade on the next `plur init` (now version-aware).

### Packages

- `@plur-ai/core` 0.9.4 — pinned field, embedder helpers, build config fix, opt-out, mode reporting
- `@plur-ai/mcp` 0.9.4 — `plur_doctor`, `plur_pin`, hybrid-degraded + bm25-only mode reporting, version-aware pack upgrade
- `@plur-ai/cli` 0.9.4 — extended `doctor` with embedder check + opt-out hints
- `@plur-ai/claw` 0.9.10 — version bump (independent track; was 0.9.9 on npm)

## 0.9.3 (2026-04-22)

### Fixes

- **ESM import fix in core** (critical): Replaced `require('os')` and `require('path')` with ESM imports. The CJS `require()` calls crashed consumers running PLUR in pure-ESM environments (Node 20+ with `"type": "module"`, modern bundlers). Affects `autoDiscoverStores` and related code paths in `@plur-ai/core`.

### Packages

- `@plur-ai/core` 0.9.3 — ESM import fix
- `@plur-ai/mcp` 0.9.3 — version parity
- `@plur-ai/claw` 0.9.3 — version parity
- `@plur-ai/cli` 0.9.3 — version parity

## 0.9.2 (2026-04-22)

### Auto-Discover Moved Into the Constructor

Project-store auto-discovery now happens inside the `Plur` constructor instead of on first `init()`. Claw and Hermes get it for free — no extra wiring required.

- **Auto-discover in constructor**: `new Plur({...})` scans for project stores immediately. Previously only the MCP server triggered discovery.
- **MCP bundles effective-memory pack**: The MCP server ships the `effective-memory` pack bundled and auto-installs it on `plur init`. Closes the gap where new installs had zero prior-art knowledge until a manual `plur pack install`.
- **BM25 fallback for tiny corpora** (#30, #31): Robust BM25 behavior for stores with very few engrams or uniform term frequencies — previously returned empty results. Matches expectations on fresh installs.

### Packages

- `@plur-ai/core` 0.9.2 — auto-discover in constructor, BM25 fallback
- `@plur-ai/mcp` 0.9.2 — bundled effective-memory pack, auto-install on init
- `@plur-ai/claw` 0.9.2 — version parity
- `@plur-ai/cli` 0.9.2 — version parity

## 0.9.1 (2026-04-22)

### Auto-Discover Project Stores

A multi-project setup used to need explicit `--domain`/`--scope` flags on every call. 0.9.1 auto-discovers `.plur/` directories in the working tree at session start, so engrams from parent and sibling projects join the recall pool automatically.

- **Auto-discover project stores at session start**: Walks upward from `cwd` collecting `.plur/` stores; registers them alongside the global store. Makes multi-repo workflows work without config.
- **Project engram store**: Adds 67 PLUR-specific learnings (architecture, conventions, gotchas) shipped in the repo itself so contributors inherit team knowledge on first clone.
- **CLI + Hermes feature parity with 0.9.0**: `similarity-search` and `batch-decay` exposed in CLI and Hermes plugin to match the 0.9.0 core additions.
- **skills.sh ecosystem publish**: `plur-memory` skill published to skills.sh — reach across amp, cline, opencode, cursor, kimi-cli, and warp via SKILL.md auto-indexing.

### Packages

- `@plur-ai/core` 0.9.1 — auto-discover project stores, project engram store
- `@plur-ai/mcp` 0.9.1 — version parity
- `@plur-ai/claw` 0.9.1 — version parity
- `@plur-ai/cli` 0.9.1 — similarity-search + batch-decay parity

## 0.9.0 (2026-04-22)

### Memory That Maintains Itself

Engrams now have a lifecycle. They strengthen when used, weaken when forgotten, merge when duplicated, and leave an audit trail of every event. Until now PLUR had learn and recall but no maintenance — an untouched engram from January had the same injection priority as one used yesterday. 0.9.0 closes the loop.

- **Similarity search with cosine scores**: `similaritySearch()` returns `{engram, score}[]` for dedup classification. Thresholds: >0.9 duplicate, 0.7-0.9 related, <0.7 new. Scores clamped to [0, 1].
- **Batch decay**: `batchDecay()` applies ACT-R exponential decay to all primary engrams. Emotional weight slows decay for painful lessons. Scope-matched engrams are immune. Status transitions (active/fading/dormant/retirement) are logged to history.
- **Extended lifecycle events**: 5 new history event types — `recurrence_detected`, `contradiction_detected`, `scope_promoted`, `buffer_pruned`, `weekly_review`. Foundation for weekly reports and team dashboards.
- **MCP tools**: `plur_similarity_search` and `plur_batch_decay` exposed to agents for automated learning loops.
- **Multi-store search verified**: `recallHybrid` and `similaritySearch` confirmed to include engrams from registered project stores.

### Fixes

- **Scope matching precision**: Decay now uses exact + child matching (`project:alpha/sub` matches `project:alpha`, but `project:beta` does not). Previously all same-type scopes matched.
- **Engram cache invalidation**: `batchDecay` uses `_writeEngrams` for proper cache invalidation after writes.
- **Engram cache race fix** (#25, #26): Writes invalidate the read-cache via `_writeEngrams` helper. Fixes intermittent "Engram not found" failures when read and write happen in the same second.

### Multi-Project Setup Improvements (#19, #24)

- **Default to project-level config**: `plur init` creates `.claude/settings.json` in the current directory by default. Users who want global config can use `--global` flag.
- **Improved documentation**: Clarified `--domain` and `--scope` flags as the multi-project scoping solution.

### Packages

- `@plur-ai/core` 0.9.0 — similarity search, batch decay, extended history events
- `@plur-ai/mcp` 0.9.0 — plur_similarity_search + plur_batch_decay tools
- `@plur-ai/claw` 0.9.0 — version parity
- `@plur-ai/cli` 0.9.0 — project-level config, multi-project docs

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
