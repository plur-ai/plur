# Outbox (decisions C3, C4, C5) — `PlurSpec/Outbox.lean`

Scope: the outbox as merged on main by #1277 and carried into #1228 under owner decision C3 (2026-09-29): per-entry claims, the idempotency key persisted before the first POST, plain retry, the refusal classification and the per-host breaker. There are no row leases and no "maybe delivered" state.

- §1–§3 (C4): with one key per logical write, a key-honouring server stores it at most once however often it is retried (`honour_at_most_once`); a key-ignoring server stores one row per attempt it stored (`ignore_one_row_per_landed`), with no fixed bound per write; a write leaves the queue only after the server stored it (`dequeued_only_when_stored`). `measured_scenario` is the contract's measured case (4 rows vs 1). The key is persisted before the first POST and never changes (`row_key_stable`, `retry_same_key`, `no_keyless_post`).
- §4: the takeover of a lapsed claim has one winner because the marker is created with O_EXCL (`excl_one_winner`, `excl_someone_wins`); read-compare-rename let every racer win (`read_compare_many_winners`); the claim path is never empty (`takeover_never_empty`).
- §5 (kept from #1228): only the writer that took a claim releases it (`only_taker_releases`, `taker_releases`); counterexample for main's rule (`main_rule_foreign_release`), replayed by `packages/core/test/outbox-claim-ownership.test.ts`.
- §6 (kept from #1228): `leased_until` is read from the claim file alone (`listing_ignores_row`).
- §7 (C5): a 401/403/404/422 never feeds the breaker, on either leg (`write_refusal_never_counts`, `recall_refusal_never_counts`).
- §8 (#1299): a needs_action entry is only skipped, never dropped or rescoped (`held_untouched`, `kept_only_bookkeeping`, `verdict_only_skips`, `force_dials_needs_action`).

Cross-process exclusion of pushers: `WritePath.lean` §1c (`claimed_at_most_once_across_processes`).
