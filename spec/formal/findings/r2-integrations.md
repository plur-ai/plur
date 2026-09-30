# Findings — R2-Integrations (round 2, 2026-09-26)

Model: `spec/formal/PlurSpec/R2Integrations.lean` (namespace `PlurSpec.R2Integrations`).
Checked with `lake env lean PlurSpec/R2Integrations.lean` (no sorry/axiom/native_decide).
Mutation checks run on scratch copies (`scratchpad/mut/mut.sh`).

## 1. plur_admin dispatch vs annotations (mcp#6) — CONFIRMED+FIXED (2 hints) + CONFIRMED+NEEDS-OWNER (destructive classification)

Code: packages/mcp/src/tools.ts `buildAdminDispatchTool` refuses a target iff
`annotations.destructiveHint === true`; every other tool is dispatchable.

(a) FIXED. `plur_session_start` was `readOnlyHint: true`, yet it registers the
session scope, flushes the outbox (pushes to remote stores) and writes telemetry.
A host may run a read-only tool without asking. Now `readOnlyHint: false,
destructiveHint: false` (it only replays writes already requested).
(b) FIXED. `plur_tensions` was `idempotentHint: true`; scan persists each NEW
detection and the LLM judge can find new pairs on a repeat call. Now
`idempotentHint: false` (claiming less is always safe).
`plur_rescope`'s `idempotentHint: true` holds: a second call on the retired
source errors, and on an already-moved engram is a noop (core `_rescopeOne`).

(c) NEEDS-OWNER. `plur_tensions` (`action:"resolve"` retires the loser, with no
copy — the same effect as `plur_forget`) and `plur_rescope` (retires the local
original after a remote push) are `destructiveHint: false`, so both run through
`plur_admin` while `plur_forget` is refused there. Replay
(formal-r2-integrations-annotations.test.ts, last case, through the real lean
`plur_admin` handler): `plur_forget` via admin → `success:false`;
`plur_tensions {action:"resolve"}` via admin → `retired: <loser>`, loser status
`retired`. Not fixed because every fix breaks a test that pins the current
surface on purpose: rescope-tool.test.ts:38 ("a move, not a delete — it must
stay dispatchable through plur_admin") and tool-profile.test.ts (lean profile
≤ 12 tools; the documented rule is "every destructive tool is a direct tool in
every profile", so marking one destructive adds a direct tool).
Question: should retiring through tensions resolve / rescope be gated like
plur_forget?
- (A) Mark both destructive; expose both directly in lean/cursor (13 direct
  tools); overturn the rescope "move" pin.
- (B) Mark only `plur_tensions` destructive and expose it directly (12 + 1 = 13
  direct tools); keep rescope as a move, since its retirement always leaves a
  pushed copy with a `superseded_by` link. **Recommended**: resolve is exactly
  forget's effect; rescope loses no content.
- (C) Keep annotations; accept that retirement through plur_admin is ungated.

Theorems (§1): `admin_never_retires` (destrSound ⇒ admin never dispatches a
retiring tool — the guarantee the admin comment documents), `fixed_ro_idem_sound`,
counterexamples `orig_session_start_ro_lies`, `orig_tensions_idem_lies`; the
NEEDS-OWNER state `tensions_resolve_via_admin`, `rescope_retires_via_admin`;
non-vacuity `admin_dispatches_status`, `admin_refuses_forget`.
Mutation: session_start `ro := true` or tensions `idem := true` → `fixed_ro_idem_sound`
fails (decide).
Files: packages/mcp/src/tools.ts (two annotations + comments).
Test: packages/mcp/test/formal-r2-integrations-annotations.test.ts (4): 3 failed
before, 4/4 after; with server.test.ts, tool-profile.test.ts, tensions.test.ts: 92/92.


Decision I applied: `plur_tensions` gated (owner, 2026-09-27, row `I_tensions_resolve`,
principle "every removal needs an explicit, gated act"; option B).
- `plur_tensions` is `destructiveHint: true` (resolve retires the loser with no copy,
  forget's effect): plur_admin refuses it, and it is a direct tool in lean/cursor
  (`CURSOR_CORE_TOOL_NAMES`).
- `plur_rescope` stays `destructiveHint: false`, with the reason at its annotation: a
  rescope always leaves a copy (in place for local targets; a pushed copy linked by
  `superseded_by` for remote targets). It is a move, not a removal.
- Audit of every other tool reachable through plur_admin: one more remover found and
  gated under the same rule. **`plur_validate_meta`**: when a meta-engram below top
  level fails validation in a third domain, core `meta/validation.ts` sets
  `status = 'retired'` and the handler persists it with `updateEngram` (there is no
  `engram_retired` history event, and the response does not say the engram was
  retired). CONFIRMED by replay through the real lean `plur_admin` handler (temp dir,
  stubbed `fetch` judge, no network): no error, and the meta-engram's status became
  `retired`. It is now `destructiveHint: true` and a direct tool. The lean profile is
  11 + 2 direct tools + plur_admin = **14** (the decision text said 13; the extra one
  is validate_meta).
  Not gated, and why: `plur_sync` (git pull may bring in retirements another host made;
  the removal act happened there); `plur_outbox flush` (delivers a remote retirement
  already queued by a direct `plur_forget`); `plur_learn` `supersedes` (adds a
  `superseded_by` edge and down-weights injection ×0.3, retires nothing);
  `plur_promote` (candidate → active only); `plur_stores_add` (replaces config, not
  memory); `plur_packs_install` over an existing pack of the same name (swaps the
  installed copy for the version the caller named explicitly, so the old version's
  engrams go; treated as an upgrade, left for the owner as a question below).
- Theorems (§1, re-checked with `lake env lean PlurSpec/R2Integrations.lean`): new
  `Effects.copyRemains`, `removes`, `removalGated`; proved `admin_never_removes`,
  `fixed_removal_gated`, `fixed_admin_never_removes`, `fixed_destructive_is_direct`,
  `lean_profile_size` (14); non-vacuity `rescope_move_dispatched`,
  `admin_refuses_tensions`, `admin_refuses_validate_meta`. `tensions_resolve_via_admin`
  is now a labelled PRE-DECISION counterexample (on `tensionsPreI`), and so is the new
  `validate_meta_retires_via_admin`. `pre_decision_not_gated` also holds.
  `rescope_retires_via_admin` is kept on purpose: it is a move.
- Mutation checks (scratch copies): tensions `destr := false` → `fixed_removal_gated`
  fails; `plur_tensions` removed from `coreNames` → `fixed_destructive_is_direct` and
  `lean_profile_size` fail; validateMeta `destr := false` → `fixed_removal_gated`
  fails; rescope `copyRemains := false` → `fixed_removal_gated` fails.
- Files: packages/mcp/src/tools.ts (two annotations, the core set, comments),
  packages/mcp/README.md (lean table 12 → 14 tools).
  Tests: new packages/mcp/test/formal-r2-apply-mcp-removal-gated.test.ts (6; 4 failed
  before the change). Changed: tool-profile.test.ts (cap 12 → 14, with the reason;
  both new tools asserted as direct and refused by plur_admin), and
  formal-r2-integrations-annotations.test.ts (the replay case that pinned "resolve via
  admin retires" now pins the refusal).
- Open question: should `plur_packs_install` that replaces an installed pack
  of the same name count as a removal (making install destructive and direct, so
  15 tools), or stay an upgrade?

## 2. Hermes bridge dedup / forget / tool-path scope (mcp#5) — CONFIRMED+FIXED (bridge) + NEEDS-FILE (core)

Code: packages/hermes/plur_hermes/bridge.py `learn` short-circuits (returns
`deduplicated: true`, no CLI call) on (i) an in-process LRU cache keyed by the
normalised statement only and (ii) `_find_duplicate`, a recall hit with the same
text in ANY scope. Core's hash dedup is scope-aware (#136).
Defects confirmed:
(a) a team-scoped write of a statement already learned/recallable in another
scope was swallowed; (b) `forget` left the cache serving the retired id until
the TTL; (c) both tool paths (`memory_provider.py` `_dispatch`, `__init__.py`
`_make_handler`) sent `scope="global"` when the caller omitted it, contradicting
the bridge's own #9 contract (omit → core's auto-route / unscoped_default); the
two tool schemas advertised `"default": "global"`.
Replay (real bridge against the built CLI, temp HOME/PLUR_PATH,
scratchpad/r2h/replay.py, `orig` = HEAD bridge.py):
```
orig  learn(X, project:alpha) → ENG-001; learn(X, project:beta) → ENG-001 deduplicated:True (CLI never called)
orig  forget(ENG-001); learn(X, project:alpha) → ENG-001 deduplicated:True   (stale, retired id)
fixed learn(X, project:beta) → reaches the CLI (core decides); after forget → ENG-002 (new engram)
```
Fix (bridge.py): cache key = (requested scope, statement) (`_cache_key`; an
unscoped request keeps the bare statement as key, and its entry only comes from
a real learn result, i.e. core's own routing); `_find_duplicate(statement,
scope)` accepts a hit only in the requested scope (a hit without a scope never
matches); an UNSCOPED write skips the recall shortcut entirely — the bridge
cannot know where core routes it, and a false dedup loses the write while a
missed one costs one recurrence (core's own stated direction, `_hashDedup`
docstring). `forget` clears the cache before the call (a failed/timed-out forget
may still have retired something). Engineering choice (fail closed), recorded.
Tool paths: `scope=args.get("scope")`; schemas describe "omit to let PLUR route it".
Left as is (design): meta_pipeline.py stores meta-engrams with an explicit
`scope="global"` (cross-domain principles; explicit, not a default);
`stores_add`'s `scope` default is the store's scope, not a write default.
NEEDS-FILE (core, R2-CoreA #10 "dedup/recurrence swallowing writes"): the
bridge fix is necessary but not sufficient. Core itself swallows a team write
when the same statement exists locally in another scope: `learnRouted`'s remote
route runs `_crossScopeRecurrenceDetect` (index.ts ~3572) over the merged view
and returns the LOCAL engram, never pushing or queueing. Replay (core dist,
unreachable store 127.0.0.1:9 for `group:acme/eng`):
`learnRouted(X,{scope:'project:alpha'})` → ENG-001;
`learnRouted(X,{scope:'group:acme/eng'})` → ENG-001 scope project:alpha,
outboxCount 0 (a fresh statement to the same scope → queued, outbox 1).
Exact change for core: in the remote route, skip the cross-scope recurrence
graduation when the match is not in the target scope's store (return only a
same-scope hash match; otherwise push/queue as a new engram), or make #176
graduation local-family only. Owner of the policy call is core (#176 says
recurrence graduates toward global; that must not stand in for a team push).
Pre-existing tests changed (they pinned the scope-blind shortcut incidentally,
their subject is the cache/TTL mechanics): packages/hermes/test/test_bridge.py
— the 19 dedup/cache/TTL tests (TestPlurBridge `test_learn_dedupes_*`,
`test_learn_calls_cli_when_no_duplicate`, `test_learn_falls_through_when_recall_fails`,
`test_learn_three_identical_calls_yields_one_engram`, `test_learn_inprocess_cache_*`,
`test_learn_recall_dedup_populates_cache`, `test_learn_force_bypasses_cache_read_but_updates_cache`,
`test_learn_cache_size_zero_disables_cache`, `test_learn_cache_evicts_oldest_when_full`;
all of TestDedupTtlCache that learn) now learn with `scope="global"`, their recall
hits carry `"scope": "global"`, and the two eviction asserts use
`bridge._cache_key(...)`. packages/hermes/test/test_memory_provider.py:174
`test_plur_learn` pinned `scope="global"` for an omitted scope → now `scope=None`.
Tests: packages/hermes/test/test_formal_r2_integrations_bridge.py (10): 8 failed
before, 10/10 after. Hermes suite: 218 passed, 3 failed (the known
test_memory_provider_entrypoint.py environment failures).
Theorems (§2): `fixed_dedup_same_scope` (every short-circuit is an entry for the
same scope key or a recall hit in the same explicit scope),
`fixed_forget_no_stale`, `fixed_unscoped_reaches_core`,
`fixed_team_write_reaches_core`, non-vacuity `fixed_same_scope_dedup`,
`fixed_tool_scope_passthrough`; counterexamples `orig_team_write_swallowed`,
`orig_forget_stale`, `orig_tool_scope_defeats_autoroute`.
Mutations: scope-blind recall match → `fixed_dedup_same_scope`,
`fixed_forget_no_stale`, `fixed_team_write_reaches_core` fail; forget keeps the
cache → `fixed_forget_no_stale` fails; tool default back to global →
`fixed_tool_scope_passthrough` fails.

## 3c. Follow-up: recall query starting with `-` (python client + hermes bridge) — CONFIRMED+FIXED (adapter side; depends on R2-CLI)

Replay (built CLI): `plur recall "-x marks the spot" --limit 3 --fast --json`
→ exit 1 "Unrecognised flag: -x marks the spot" (python raises PlurError, hermes
PlurBridgeError). Fix: a query beginning with `-` is sent after `--`
(hermes `PlurBridge.recall`; python `_with_query` for `recall` and
`recall_hybrid`); every other query keeps its argv. Flags appended by the
transport stay before the separator: hermes `call()` inserts `--path` before
`--`; python `run_json` inserts `--json` before `--`.
Dependency: `plur recall` must honour `--` (R2-CLI follow-up). With today's
built CLI `recall … -- "-x…"` searches for the literal "--" (exit 2, no results)
— both land together in this PR.
Theorems (§2): `recall_query_verbatim` (every query reaches the CLI parse as the
query, for the R2-CLI parse `recallParse`), `recallParse_head`; counterexample
`orig_dash_query_refused`. Mutation: never using `--` → `recall_query_verbatim` fails.
Tests: packages/python/tests/test_formal_r2_integrations_argv.py (3; 2 failed
before, 3/3 after; python suite 15/15); hermes: the two recall cases in
test_formal_r2_integrations_bridge.py.

## 3. Round-1 follow-ups (MCP, dsh) — CONFIRMED+FIXED (a, b, d, e-MCP side, f) ; e-core NEEDS-FILE

All in packages/mcp/src/tools.ts unless stated. Test:
packages/mcp/test/formal-r2-integrations-session.test.ts (6): 5 failed before
(the good-case test passed), 6/6 after.

(a) Recall uses the write rule (E7). `plur_recall` (keyword + hybrid; the
deprecated alias forwards) passed `_resolveInjectionSession(args)`, i.e.
`undefined` when not exactly one session is open, so core fell back to the
process slot — the LAST-started session's default — as the remote dialing
context. Replay (real handler + core, spy on `plur.recall` /
`recallHybridWithMeta`): sessions A(project:a), B(group:acme/eng) open, id-less
recall → `session: undefined` (→ slot = B's team scope). Fix: `_resolveWriteSession`
(explicit id, else the lone open session, else `NO_SESSION`). Descriptions of
both `session_id` inputs say so. Theorems §3: `recall_same_rule_as_write`,
`recall_ambiguous_no_default`, non-vacuity `recall_lone_session_default`,
counterexample `orig_recall_borrows_last_started`. Mutation (recall back to the
injection resolver) → both theorems fail.

(b) `plur_session_scope op:"set"` with ZERO sessions open now refuses ("no
session is open, so there is no session scope to set — … Call
plur_session_start first …") instead of accepting into the process slot with a
warning: after (a) no id-less call (learn, inject, recall) reads that slot.
`show` still answers (warning text updated: the slot governs neither writes nor
dialing); `clear` unchanged. Tool description notes it. Theorems:
`set_accepted_is_observable` (an accepted id-less set targets a registration an
id-less call reads), counterexample `orig_zero_session_set_unobservable`.
Mutation (accept the zero-session slot again) → `set_accepted_is_observable` fails.
Pre-existing tests changed (they pinned the round-1 behaviour this follow-up
replaces): packages/mcp/test/formal-apply-surface-session.test.ts "plur_session_scope
set with no session open …" (now expects the refusal; `show` still warns);
packages/mcp/test/session-scope-tool.test.ts "recall dialing follows the session
scope org …" (starts a session before setting the scope).

(d) Refusal wording. Core refuses two kinds of auto-route candidate alike
(`refusedShared`): a shared scope (#1115) and a personal scope on a URL store not
verified as the user's own `/me` namespace (E1 "me-only"). MCP called both
"a SHARED scope". Replay (real core, config with a URL store `user:bob`
covers `deploy.pipeline`, host 127.0.0.1:9, never contacted):
`plur_suggest_scope {domain:"deploy.pipeline.canary"}` → note `"user:bob" is the
best match but is a SHARED scope …`. Fix: `describeRefusedRoute(scope)` →
`{kind: 'shared'|'remote-personal', what, rule}` used by plur_suggest_scope
(`refused_shared` kept for compatibility, `refused_kind` added), plur_learn's
`route_refused` warning (+ `kind`), and plur_learn_batch's summary. Theorems:
`refusal_kind_truthful`, counterexample `orig_personal_called_shared`.
Mutation (always `.shared`) → `refusal_kind_truthful` fails.

(e) Outbox. Core queues remote retirements as `structured_data._retireRemote`
(flushed by `_flushOutboxClaimed`) but `listOutbox()` / `outboxCount()` do not
report them (index.ts ~7945-7998) — R2-CoreA's follow-up. MCP side done:
`plur_outbox` passes through whatever `listOutbox()` returns (no filtering), its
description mentions queued remote operations such as retirements, and
`pending` after a flush is now `listOutbox().length` instead of the separate
`outboxCount()` (which would miss any entry kind the list shows). Test: the
outbox case (spy: a listed `kind:'retire'` entry is shown, and pending=1 after a
flush; was 0). Theorems: `pending_counts_every_listed`,
counterexample `orig_pending_misses_retire`. Mutation → both fail.
NEEDS-FILE (core, R2-CoreA): `listOutbox()` should add an entry per non-in-flight
row carrying `_retireRemote` (`{ id, target_scope, queued_at, attempt_count,
last_error?, age_days, kind: 'retire' }`, existing entries `kind: 'push'`), and
`outboxCount()` count the same set, so the CLI and MCP show a stuck remote
retirement.

(f) dsh write hard cap documented as a constant: packages/dsh/src/guard.ts
(`WRITE_HARD_CAP_MS` docstring: a constant on purpose, tied to core's lock
threshold; only a larger `timeoutMs` raises it; nothing lowers it) and
packages/dsh/src/config.ts (`timeoutMs` docstring). packages/dsh/README.md is
not in my file list — suggested line for the `timeoutMs` row: "The 60 s cap is a
constant (it matches core's store-lock stale threshold), not a setting; only a
larger `timeoutMs` raises it." No behaviour change, no test.

Targeted MCP run after (a)-(e): formal-apply-surface-session, session-scope-tool,
outbox-tool, tools, session, formal-adapters-session, formal-r2-integrations-*,
server, tool-profile, admin-gateway, rescope-tool, tensions: 13 files 260/260;
budget-schema, content-hash-exposure, e2e-remote, measured-under,
readme-tool-table, remote-recall-surfacing, sp2-tools, tool-surface,
dist-validation: 9 files 66/66.

## 4. migrate codemod (mcp#8) — CONFIRMED+FIXED (3 defects)

(a) Nested fixes on one line. `applyFixes` edits right-to-left using ORIGINAL
offsets. When a fixable call sits inside another's argument list, the inner
`await ` (6 chars) is inserted first, inside the outer wrap's span, and the
outer `wrapTo` is stale. Replay (scratchpad/nested.mts, real scanSource +
applyFixes): `const x = plur.list(plur.getById(id)).length` → findings
list@13 (wrapTo 40), getById@23 → output
`const x = (await plur.list(await plur.getByI)d(id)).length` (corrupt source).
Fix (packages/migrate/src/scan.ts): per line, the insertions already made are
recorded as (original offset, length) and every position is mapped
original → current (`map`: shift by insertions strictly before). Now
`(await plur.list(await plur.getById(id))).length`.
(b) Summary. `run --write` printed `applied ${fixable.length}` — every fixable
site — although `applyFixes` can skip one. Fix: `applyFixes` returns
`{src, applied, skipped}`; `run` sums `applied`, and a skipped site is listed as
`MANUAL` ("the rewrite could not be applied safely here — add `await` by hand")
and counts toward exit 2. (After (a) a skip is defensive: no real scan produced
one in the suite; the test crafts one.)
(c) Report-only exit. README said "`0` clean, or all findings fixed"; report
mode exited 0 with fixable un-awaited calls outstanding, which a CI gate reads
as done. Fix: exit 2 whenever un-awaited calls remain (manual sites, or
report-only fixable sites). Engineering choice (fail closed): reuse 2 rather
than a new code; `1` stays "cannot read path". README "Exit codes" and `--help`
updated. scripts/smoke-release.sh already accepts 0 or 2 (it runs `--write`).
Theorems (§4): `wrap_end_in_gap` (for ANY earlier insertions, the closing `)`
lands after original char e-1 and at or before original char e),
`shiftLe_pred`, `shiftLt_le`, `fixed_nested_wrap_in_gap` (the replayed line),
`exit_zero_means_clean`, `summary_is_applied`; counterexamples
`orig_nested_wrap_early`, `orig_report_only_exit_zero`,
`orig_summary_overcounts`; non-vacuity `no_inner_edit_same`,
`write_all_fixed_exit_zero`.
Mutations: `mapPos := e` → `wrap_end_in_gap`, `fixed_nested_wrap_in_gap` fail;
exit ignoring report-only fixables → `exit_zero_means_clean` fails; summary back
to the fixable count → `summary_is_applied` fails; `<` → `≤` in the shift →
`shiftLe_pred`/`wrap_end_in_gap` fail.
Files: packages/migrate/src/scan.ts, src/index.ts, README.md.
Test: packages/migrate/test/formal-r2-integrations-codemod.test.ts (5): 4 failed
before, 5/5 after; whole migrate package 6 files 106/106. No pre-existing test changed.

## 3g. Applied on R2-CLI's behalf: plur_session_end checkpoint path — FIXED

packages/mcp/src/tools.ts `plur_session_end` checkpoint cleanup: `process.env.PLUR_PATH ?? …`
→ `||` (an empty PLUR_PATH means unset, as in the CLI hooks; with `??` it looked in
`./sessions`). Test packages/mcp/test/formal-r2-integrations-checkpoint.test.ts (1):
failed before (checkpoint under ~/.plur/sessions left behind), passes after;
with session.test.ts 28/28. Model: R2-CLI's (findings/r2-cli.md item 2).

## 5. claw setup/repair + context engine (mcp#11) — CONFIRMED+FIXED (4 defects)

(a) setup (postinstall) overwrote a memory slot held by another plugin; repair
and doctor treat that as a human's call. Replay (runSetup, temp config
`{plugins:{slots:{memory:"other-memory"}}}`) → written `plur-claw`. Fix
(setup.ts `mergeEnable`): only fill an empty slot; a foreign holder is kept and
`slot_selected` reports fail with the holder named (`foreignSlotStep`), the same
status doctor gives. postinstall still exits 0 (`|| true` in package.json).
(b) A non-object `plugins` (string/array/number) — and likewise
`plugins.entries`, `plugins.slots`, `mcp`, `mcp.servers` — was replaced by `{}`
and the user's value lost on write (setup and repair). Replay: `{"plugins":
"disabled-by-admin"}` rewritten. Fix: `configShapeProblem(cfg)`; setup reports
`plugin_enabled` fail ("plugins is not an object — left untouched …") with the
fallback block and does not write; repair returns the doctor report unwritten.
(c) context-engine `_learnIfNew` added the statement to the session's learned
set before `await learnRouted`; a failed write was never retried that session.
Replay (spy rejecting once): second occurrence not attempted. Fix: claim before
the await (still prevents concurrent duplicates), release on failure.
(d) Top-level session state (scopes, message buffers, learned sets) was never
dropped — OpenClaw's ContextEngine has no session-end hook — so a long-lived
gateway grew without bound. Fix: `MAX_TRACKED_SESSIONS = 1000`, LRU on all three
maps, touched on every use (only idle sessions evict). Engineering choice,
recorded: an evicted session loses its per-session dedup (core still dedups)
and its `session:<key>` scope until it re-bootstraps.
Theorems (§5): `setup_agrees_with_repair`, `setup_never_takes_foreign`,
`setup_fills_empty_slot`, `user_value_never_discarded`, `failed_learn_retried`,
`ok_learn_not_repeated` (non-vacuity), `lru_bounded`, `lru_keeps_latest`;
counterexamples `orig_setup_takes_foreign`, `orig_discards_user_value`,
`orig_failed_learn_never_retried`, `orig_unbounded`.
Mutations: setup takes a foreign slot → `setup_agrees_with_repair`,
`setup_never_takes_foreign` fail; non-object → `{}` → `user_value_never_discarded`
fails; mark before success → `failed_learn_retried` fails; no cap →
`lru_bounded` fails.
Files: packages/claw/src/setup.ts, src/context-engine.ts.
Test: packages/claw/test/formal-r2-integrations-claw.test.ts (12): 10 failed
before, 12/12 after; whole claw package 12 files 123/123 (against core dist).
No pre-existing test changed.

## 6. opencode render latch / turn buffer / unbounded recall (mcp#10) — CONFIRMED+FIXED (3 defects)

Replays through the real plugin hooks (fake store), in
packages/opencode/test/formal-r2-integrations-opencode.test.ts, all 3 failing before:
(a) Double injection: latched session → `chat.message` pushed the block as a
synthetic part AND `system.transform` (which fires again, and heals the latch)
pushed the same block into the system prompt of the same request (1 system copy
+ 1 part). Fix (index.ts): a per-session `fallbackInjected` flag, set when the
fallback pushes, reset at the next `chat.message` and on `session.deleted`;
transform still calls `markRendered` (healing) but does not push when set.
(b) Late snapshot: after `session.idle` took the buffer, a late cumulative
update of the same part re-armed `fresh`, and the next idle learned the whole
transcript again (learnRouted ×2). Fix (turn.ts): part ids handed out by
`takeIfFresh` are "taken"; updates to a taken part are ignored; the set resets
when the next turn's user message is marked, and on `clear`.
(c) `injectHybrid` in `chat.message` was awaited unbounded — a hung store
blocked the user's turn (test timed out at 20 s). Fix: `INJECT_TIMEOUT_MS =
10_000` race; past it the turn proceeds without a memory block (the previous
turn's block is cleared rather than rendered for a different query), a warning
is logged, the late result is dropped (its rejection handled), and the
user-text learning still runs. Engineering choice (bound value), recorded.
Theorems (§6): `exactly_one_copy`, `late_snapshot_learned_once`,
`new_part_learned` (non-vacuity), `wait_bounded`; counterexamples
`orig_double_injection`, `orig_late_snapshot_learned_twice`, `orig_wait_unbounded`.
Mutations: transform always pushes → `exactly_one_copy` fails; append ignores
`taken` → `late_snapshot_learned_once` fails; no bound → `wait_bounded` fails.
Files: packages/opencode/src/index.ts, src/turn.ts.
Test: formal-r2-integrations-opencode.test.ts (5): 3 failed before, 5/5 after;
whole opencode package 12 files 85/85; `tsc --noEmit` clean. No pre-existing test changed.

## 7. ui Host normalisation (mcp#12) — CONFIRMED+FIXED (2 defects, both low)

(a) `normaliseHostName` claims idempotence ("load-bearing") but `[[::1]]` →
`[::1]` → `::1`. It erred toward refusal (no bypass found: `[[::1]]` was 403
before too). Fix: unwrap brackets only when the inner value holds no bracket
(`/^\[([^[\]]+)\](?::\d+)?$/`); `[[::1]]` now stays as is (matches nothing).
(b) `hostIsAllowed` allowed `name === ''` (meant for an absent Host), so a
present `Host: :80` normalised to '' and was served 200 (replayed with a raw
request against a real `createUiServer`). Not browser-sendable, but it is not
the documented exemption. Fix: only an absent/empty RAW header is exempt; a
present value must normalise to a built-in or allowlisted name.
Theorems (§7): `norm_idempotent`, `norm_unwraps_single` (non-vacuity),
`present_empty_refused`, `absent_allowed`; counterexamples
`orig_not_idempotent`, `orig_colon_port_allowed`. Mutations: unwrap any layer →
`norm_idempotent` fails; re-allow '' → `present_empty_refused` fails.
Files: packages/ui/src/server.ts.
Test: packages/ui/test/formal-r2-integrations-host.test.ts (20): 3 failed
before, 20/20 after; whole ui package 6 files 154/154. No pre-existing test changed.

## Field report pass, cluster 4 (2026-09-29): tools.ts drift — REFUTED (holds, proved)

The drift is mcp `tools.ts`: #1264 delivery fields, #1299 outbox states, #1278
checkpoint keys. The existing §3 outbox theorem `pending_counts_every_listed`
still holds, since `pending` is still `before.length`. Added to §3:
- `summary_partition`: core `summarizeOutbox` splits the listed entries into
  `retrying + needs_action = pending`. Example: `summary_example`.
- `reader_finds_writer`: `plur_session_end` tries the Stop hook's
  `safeSessionKey(id).slice(0,64)` key (`_` per unsafe character, `unknown` when
  empty) for every raw id, alongside the older stripped form.
  `orig_strip_reader_misses` is the pre-#1278 reader, which tried only the
  stripped form (from the diff against `origin/verify/formal-lean`; not replayed
  in this pass).

The #1264 `delivery` / `delivery_warning` fields do not change §1's claims:
`outbox: true` is still set iff the row carries `_outbox` (Adapters §1
`warning_truthful`). Mutation check: dropping the `_` form from the reader
breaks `reader_finds_writer`; `retrying := pending` breaks `summary_partition`.
Checked with `lake env lean PlurSpec/R2Integrations.lean` (exit 0).
