# Modelling clusters — run of 2026-09-23 (origin/main 6200dbf6)

Four modelling agents, disjoint file ownership. Survey leads referenced as <report>#<n> (spec/formal/survey/).
Anything needing a file outside an agent's list is reported NEEDS-OWNER / NEEDS-FILE, not edited.
New tests: packages/<pkg>/test/formal-<cluster>-*.test.ts (or test_formal_<cluster>_*.py). Existing test files: read-only.

## WritePath  → PlurSpec/WritePath.lean, findings/writepath.md
Owns: packages/core/src/index.ts, content-fields.ts, store/remote-store.ts, session-scopes.ts
Leads: core-index#1 outbox races, #3 _outbox/scope invariant, #2 private-stays-local predicates, #6 auto-route pipeline,
core-policy#2 remote-backed personal auto-route, #11 scope_source validation, core-index#5 tension fail-open, #4 readonly tension mutators,
core-index#11 rescope atomicity.

## ScopeInject → PlurSpec/ScopeInject.lean, findings/scopeinject.md
Owns: packages/core/src/scope-util.ts, scope-target.ts, scope-routing.ts, inject.ts, memory-block.ts, telemetry-miss-signal.ts, learner.ts, decay.ts
Leads: core-policy#12 + #1 scope-family predicate drift, core-retrieval#1 inject visibility bypass, #3 pinned priority across passes,
#5 token budget, #6 renderMemoryBlock, #2 miss-signal, #4 learner polarity, core-policy#8 decay NaN floor.

## Persistence → PlurSpec/Persistence.lean, findings/persistence.md
Owns: packages/core/src/sync.ts, migrations/runner.ts, store/async-lock.ts, storage-postgres.ts, backup.ts, outbox-order.ts, learn-async.ts, packs.ts
Leads: core-persistence#1 sync never pulls, #2 migration stale restore, #3/#4 lock steal, #5 pg unlock, #7 backups stop, #6 unrecoverable list,
#10 orderBySupersedes, #8 learn-async locked check, core-policy#5 pack hash, #4 pack registry name.

## Adapters → PlurSpec/Adapters.lean, findings/adapters.md
Owns: packages/cli/src/commands/init.ts, cursor-hooks.ts, mcp-config.ts, commands/forget.ts, commands/feedback.ts, commands/scopes.ts,
commands/init-remote.ts, packages/mcp/src/tools.ts, packages/dsh/src/ (all), packages/hermes/plur_hermes/bridge.py, packages/python/plur_ai/client.py
Leads: cli#1 settings.json merge, #2 cursor keys, #3 env replace, #5 exit codes, #9 init-remote, mcp-integrations#1 session lifecycle,
#3 learn rule drift (batch pinned quota, session_end), #4 dsh "Stored." without engine, #7 argv flag injection, #9 comma split,
#2 + cli#4 .plur.yaml trust (decision board expected).

Deferred (not modelled this run, listed for the next run): cli#6-8,10-12; mcp-integrations#5,6,8,10-12; core-retrieval#7-12;
core-index#7-10; core-policy#3,6,7,9,10; core-persistence#9,11,12.
