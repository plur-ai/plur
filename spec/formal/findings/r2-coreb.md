# Findings — R2-CoreB (round 2, 2026-09-26, base a831872b)

Model: `spec/formal/PlurSpec/R2CoreB.lean` (namespace `PlurSpec.R2CoreB`).
Check: `cd spec/formal && lake env lean PlurSpec/R2CoreB.lean` (no output = clean; no sorry/admit/axiom/native_decide).
Tests: `npx vitest run --testTimeout=120000 packages/core/test/formal-r2-coreb-ingestion.test.ts packages/core/test/formal-r2-coreb-health.test.ts`.
Files changed: `packages/core/src/remote-recall.ts`, `packages/core/src/store/remote-store.ts`, `packages/core/src/tensions.ts`.
Pre-existing tests changed: none.

---

## 1. Server-supplied `_pack` survives remote ingestion (core-policy#6)

**Verdict: CONFIRMED + FIXED** (remote legs, in owned files) · residue for file-backed stores and packs → NEEDS-FILE.

Mechanism: `RemoteRowSchema` is `.passthrough()`, and neither `RemoteStore.reshape` (load leg) nor
`processHostRows` (recall leg) dropped `_`-prefixed keys. The loaders only ADD `_storeScope`, and
`engramOrigin` read `_pack` first, so a remote row that ships `_pack: "<installed pack>"` got
`origin = pack:<installed pack>` — equal to the real pack rows' origin. `measuredUnderGateApplies`
then removed a pack-vs-remote pair from the judge whenever the (free-form, writer-controlled)
`measured_under` dimensions differed: exactly the #981 attack the origin check exists to stop. The
docstring's "a row that ships its own marker can only look MORE foreign" was false: it could look
like a *different* foreign origin.

Replay (unfixed code, temp vitest file, mocked `fetchImpl`): forged recall row with `_pack:
installed-pack` → `["REPLAY origin=","pack:installed-pack","gate=",true]`. After the fix:
`["REPLAY origin=","store:group:plur/plur-ai/engineering","gate=",false]`. The load leg replayed the
same way through a local HTTP server (`RemoteStore.load` returned `_pack: 'installed-pack'` before).

Fix:
- `remote-store.ts` `salvageRemoteRow` (the trust boundary both remote legs share) drops every
  top-level `_`-prefixed key before validation (`withoutLoaderMarkers`).
- `remote-recall.ts` new exported `stampStoreRow(e, storeScope)` — the loader's stamp: drop `_` keys,
  narrow `global`, namespace idempotently, stamp `_originalId`/`_storeScope`. Used by `processHostRows`.
- `tensions.ts` `engramOrigin`: a row carrying BOTH `_pack` and `_storeScope` (no loader stamps both,
  so one was forged) gets an `ambiguous:` origin, which `measuredUnderGateApplies` never gates —
  fail-closed (the pair reaches the judge). This also covers file-backed stores, whose loader in
  index.ts still does not strip.

Theorems (`PlurSpec.R2CoreB.Origin`):
- `old_remote_takes_pack_origin`, `old_gate_crosses_trust_boundary` — counterexample (every oracle `M`).
- `remote_origin_is_store` / `remote_origin_never_pack` — **the origin of a loaded remote row is never a pack origin**.
- `store_loaded_never_pack`, `pack_loaded_never_store` — even without stripping (file-backed store / pack loader), origin can't cross.
- `gate_never_crosses` — the gate never pairs a pack-loaded row with a store-loaded row.
- `gate_same_store_reachable` — non-vacuity.

Mutation check: removing the strip from `remoteLoad` → `remote_origin_is_store`,
`remote_origin_never_pack` stop proving; reverting `origin` to pack-first →
`store_loaded_never_pack`, `gate_never_crosses` stop proving.

Tests: `formal-r2-coreb-ingestion.test.ts` §core-policy#6 (6 tests; 5 failed before the fix).

NEEDS-FILE (R2-CoreA, `index.ts` `_loadSecondaryAndPacks`):
- store loop (≈1386–1398): replace the clone / `global` narrow / regex namespace / stamp block with
  `const cloned = stampStoreRow(e, store.scope) as any` (import from `./remote-recall.js`). Strips a
  forged `_pack` from file-backed store rows too, so `withoutPacks` (≈5484) and injected-pack counting
  (≈5562) stop misclassifying them; also closes §2b below.
- pack loop (≈1412): drop `_`-prefixed keys from `e` before `cloned._pack = …`
  (`Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith('_')))`), so a pack row can't
  ship `_storeScope`/`_originalId`.

---

## 2. Remote-row ingestion implemented twice (core-policy#7)

### 2a. `...act` overwrote the type-guarded activation defaults — **CONFIRMED + FIXED**

`processHostRows` built `{ storage_strength: guard, frequency: guard, ...act, retrieval_strength: guard }`:
the spread of the raw server object came AFTER the two guards, so a string `storage_strength` or a
`null` `frequency` replaced the default it was guarded against. Replay: server activation
`{storage_strength: 'high', frequency: null}` → recall row carried `'high'` (test failed with
`expected 'high' to be 1`). Fix: spread first, then all three guarded fields.

Theorems (`Activation`): `old_guard_defeated` (counterexample), `new_guarded_numeric` (every guarded
field is numeric for every server object), `new_keeps_server_values` (non-vacuity: numeric values and
unmodelled keys kept). Mutation: spread-last → `new_guarded_numeric` stops proving.

### 2b. Namespacing drift between the load leg and the recall leg — **CONFIRMED + NEEDS-FILE**

- The load leg (`index.ts`) namespaces with a bare regex replace, which is not idempotent; the
  recall leg uses `namespaceEngramId`, which is. Replay through `Plur.list` against a local stub
  with a server id already carrying the prefix: load leg `ENG-GPL-GPL-2026-09-26-001`, recall leg
  `ENG-GPL-2026-09-26-001` — two ids for one row (splits RRF dedup; feedback resolves the wrong one).
  Fix is the NEEDS-FILE above (use `stampStoreRow`).
- `global` rows: the load leg narrows a global row into EVERY store entry whose load returned it; the
  recall leg narrows it to the first DIALED entry, so its id depends on which scopes the session
  dials. Engineering design (all entries of one (url, token) reach the same server row, so feedback
  lands on the same row); left as is, and the `RemoteRecallHost.entries` docstring — which claimed it
  "mirrors `_loadSecondaryAndPacks`" — corrected.

Theorems (`Namespace`): `recall_idempotent`, `legs_agree_on_fresh`, `legs_disagree_on_prefixed`
(counterexample), `global_id_depends_on_dialing`.

Tests: `formal-r2-coreb-ingestion.test.ts` §7a (2), §7b (2 — `stampStoreRow` idempotency, marker stamping).

---

## 3. Remote-recall health keyed by URL while hosts are dialed per (url, token) (core-policy#3)

**Verdict: CONFIRMED + FIXED.**

All health state lived in one record per normalized url, but `_remoteRecallHosts` groups by
(url, token) — two tokens on one url are "two distinct credentials with independent validity"
(index.ts, `remoteEndpointTokenGroups`), and the 429 limit is per principal (doctor text). Replayed with a
mocked `fetch` answering by bearer token (all three failed before the fix):
- revoked token interleaved with a healthy one: `['unreachable','ok']` twice — never `forbidden`;
- two tokens with one 403 each in ONE call: `['unreachable','forbidden']`;
- token A's 429 → token B `skipped_cooldown` on the next call.

Fix (`remote-recall.ts`): per-credential sub-record `hosts[url].tokens[tokenHealthKey(token)]`
(`forbidden_count`, `rate_limited_until`); `tokenHealthKey` is a 16-hex SHA-256 prefix — the file never
holds a token (tested). Reachability (network failures, breaker `cooldown_until`, 404 TTL) stays
per host. Legacy host-wide `forbidden_count` is dropped on the next dial; a legacy host-wide 429
`cooldown_until` is honored until it expires. The change is additive inside an advisory cache file
(host keys unchanged, so `readRemoteHealth` consumers and the lost-update merge are unaffected).
`isHostInCooldown(url, now, path, token?)` gains an optional token: with it, that token's 429 is
reported as `rate_limit`.

Theorems (`Health`): `old_interleave_masks_revocation`, `old_two_tokens_one_round`,
`old_429_parks_other` (counterexamples); `noninterference` (a token's state is a fold of its OWN
events only — general, by induction), `other_tokens_irrelevant`, `new_interleave_forbidden`,
`new_two_tokens_unconfirmed`, `new_429_no_park`; `host_breaker_shared` (non-vacuity: the breaker
still counts every token's network failures). Mutation: a step that ignores the token →
`noninterference` and the three `new_*` theorems stop proving.

Tests: `formal-r2-coreb-health.test.ts` §core-policy#3 (6 tests). Existing `remote-recall.test.ts`
(403 streak, 429 Retry-After, breaker persistence, concurrent writers) passes unchanged.

NEEDS-FILE (index.ts ≈8191, `flushOutbox`): pass `storeEntry.token` as the 4th argument of
`isHostInCooldown`. Until then the write leg sees only the host breaker, not recall's per-token 429
(before this change it saw every token's 429 host-wide). Harmless either way — a write to a
rate-limited principal fails and stays queued — but the argument restores the skip.

---

## 4. RemoteStore.load: malformed body trips the host-down breaker (core-policy#10)

**Verdict: CONFIRMED + FIXED.**

`load()` read `r.json()` and iterated `body.rows` inside the try whose catch is the network-failure
handler: an unparseable body or a page without `rows` from a host that had just answered 200 called
`markRemoteHostDown` (fast-failing every store on the host for 60 s) and logged "load page failed" —
contradicting the breaker's own contract "HTTP responses never trip it" and `fetchBounded`, which
deliberately does not mark on a bad body. Replay (local HTTP server returning `not json {` and
`{"total_count":3}`): `remoteHostDownRemainingMs(url)` = 59998 / 59999 ms after `load()`.

Fix (`remote-store.ts`): only a thrown `fetch` marks the host. After the host answers, a body that
does not parse, or parses without a `rows` array, logs "returned an unreadable (non-JSON) page body" /
"a malformed page (no rows array)" and ends pagination as incomplete (prior cache kept, as for 5xx);
a body that stalls past the deadline is reported as such, still without a mark (fetchBounded's rule).
Non-object rows are skipped rather than thrown on; a missing `total_count` behaves as before (page
size decides).

Theorems (`LoadBreaker`): `old_malformed_trips` (counterexample), `answered_never_marks`,
`net_marks` (non-vacuity), `malformed_keeps_prior`. Mutation: restoring the body cases in `marks` →
`answered_never_marks` stops proving.

Tests: `formal-r2-coreb-health.test.ts` §core-policy#10 (3 tests; 2 failed before the fix).

---

## Test run

`npx vitest run --testTimeout=120000` over the two new files plus every core test file matching
remote|tension|outbox|pack-double|salvage|drift|breaker|recall and `packages/cli/test/hook-remote-recall.test.ts`:
34 files passed, 5 skipped (live/smoke/postgres); 548 tests passed, 36 skipped. The two new files alone: 19/19.
`tsc --noEmit -p packages/core`: no errors in the changed files.
