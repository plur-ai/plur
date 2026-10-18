# Findings: `plur login <host>` (`packages/cli/src/commands/login.ts`, #1638)

The model is `spec/formal/PlurSpec/Login.lean`. It checks cleanly with `lake env lean PlurSpec/Login.lean`: no sorry, axiom or native_decide. Branch agent/efi-c03, 2026-10-18 (plan C task 3: the device sign-in client is un-gated and writes the server entry to config.yaml).

What is abstract: the config, registration (an oracle: one whole-config write, or a refusal), the `/me` answer (it named a user and org, or not), and the time between polls (a poll budget for the code's lifetime). Left out: the device name and headless rules (string formatting), printing, and the backup `--remove-stale` makes.

## L1. The key is written at most once, and only after an `ok` token answer

**Verdict:** holds for the new code; the old (gated) flow broke it.

`runSignIn` writes nothing until `deviceSignIn` returned a checked key (token_type Bearer, a `plur_sk_` key, the C3 fields), `/me` named the user, and registration did not refuse. Registration is one locked atomic write (`registerEnterpriseServer`).
- Theorems: `Poll.at_most_one_write`, `Poll.poll_key_after_ok` (a key comes only from `ok true` after waiting answers), `Poll.write_only_after_ok`, `Poll.no_write_without_me`, `Poll.refused_registration_no_write`, `Poll.write_reachable`, `Poll.transient_bounded`.
- Counterexamples for the old flow: `Poll.old_writes_unchecked_key` (any `access_token` was written to `~/.plur/config.json`, unchecked) and `Poll.old_writes_without_me` (it wrote when `/me` failed, with username `(unknown)` and no personal scope).
- Replays: `enterprise-device-login.test.ts` "a token_type other than Bearer is refused" and "a key that is not a PLUR device key is refused"; process test "signs in, writes one server entry …".
- Mutation checks (each breaks the build): writing without the `/me` check (`m1`) breaks `no_write_without_me`, `write_only_after_ok` and `at_most_one_write`; accepting an unchecked `ok` (`m2`) breaks `poll_key_after_ok`, `refusing_no_key` and `old_writes_unchecked_key`. In the code, dropping the key-format check turns "a key that is not a PLUR device key is refused" red.

## L2. Every RFC error, and ctrl-C before the key, leave config unchanged

**Verdict:** holds.

`access_denied`, `expired_token`, `invalid_grant`, any other error, and a `200` that fails the check end the run with nothing written. `authorization_pending`, `slow_down`, a 429 and up to three transient answers in a row (network error, 5xx) only wait. ctrl-C is a run that ends after waiting answers.
- Theorems: `Poll.refusing_no_key`, `Poll.rfc_error_no_write`, `Poll.waiting_no_key`, `Poll.interrupt_no_write`.
- Replays: the `it.each` RFC-error cases and the expiry case in `enterprise-device-login.test.ts`; the process test "ctrl-C while waiting for approval" (exit 130, config.yaml byte-identical).
- Mutation check: letting `access_denied` wait (`m4`) breaks `poll_key_after_ok` and `refusing_no_key`.

## L3. `--remove-stale` removes only the entries registration names, and only with the flag

**Verdict:** holds.

Registration refuses to take over the personal scope's writes (owner decision on B5). The refusal now names the holders (`PersonalScopeTakenError`), and `removeStale` drops exactly those before the same registration runs again, in one write. A path entry that serves the scope exactly is not a holder and is never removed.
- Theorems: `Stale.no_flag_no_removal`, `Stale.non_holders_kept`, `Stale.no_holder_left`, `Stale.removal_reachable`.
- Counterexample: `Stale.byScope_drops_non_holder` (removing every entry that serves the scope would delete such a path entry).
- Replays: `register-enterprise-server-stale.test.ts` (core), and the process test "a stale entry holding the personal scope …".
- Mutation check: dropping the flag (`m3`) breaks `no_flag_no_removal`. In the code, ignoring `removeStale` in `registerServerEntry` turns 11 refusal tests red (the new suite and the existing Codex-round refusals).

## L4. The one-time config.json move never replaces a sign-in config.yaml holds (gate review, 2026-10-18)

**Verdict:** found and fixed in the gate (the move as first built replaced config.yaml's newer key with config.json's old one).

As first built, a remaining `~/.plur/config.json` whose key the server still accepted was registered for its server even when config.yaml already held a newer sign-in to that server (one written by `plur-enterprise init`, say), so `plur login --status` silently swapped the newer key for the old one, possibly another account's. Now a config.json for a server config.yaml already signs in to is set aside without contacting the server, and the file leaves its place only once its owner-only copy exists.
- Theorems: `Legacy.held_never_replaced`, `Legacy.written_only_after_ok`, `Legacy.moved_only_when_copied`, `Legacy.unreachable_kept`, `Legacy.move_reachable`.
- Counterexample: `Legacy.old_replaces_held` (the first build).
- Replays: the process test "a config.json for a server config.yaml already signs in to …" (red before the fix: the old key replaced the current one), and "config.json is set aside through the same helper; when that fails it stays where it is".
- Mutation checks: dropping the `held` test breaks `held_never_replaced` and `old_replaces_held`; setting the file aside without the copy breaks `moved_only_when_copied`.

## L5. Gate review, Codex round 1 (2026-10-18)

Fixed: the poll has one deadline (no wait past it, no key after it); the request timeout covers the body; every line after sign-in is redacted with the key; the `--remove-stale` backup is taken under registration's lock (`beforeRemove`); the config.json move re-checks `held` under the lock (`keepSignIn`). An older entry that keeps serving the personal scope ahead of the new one is not refused by core (by design, `register-enterprise-server.test.ts`); `plur login` now says so and exits 1. Whether registration should refuse it is an owner question.

## L6. Gate review, Codex round 2 (2026-10-18)

Fixed: a poll in flight at the deadline no longer hands over a key (its timeout is the time left, and a late answer does not count); an unknown token error is not echoed (only known codes are named); a local store that keeps the personal scope also exits 1; a key reflected into `/me` scope metadata is not logged (remote-store.ts names only a granted scope there; a logging change, outside every model); `plur login` builds Plur without project-store discovery, so nothing is written before the sign-in; YAML aliases no longer confuse the holder-to-position mapping in `registerServerEntry` (each position is copied first, so §2's "exactly the holders" holds per position).

## L7. The installer's store step: the key is stored at most once, only once it is known to work, and a failure leaves config.yaml unchanged (plan C task 4, 2026-10-18)

**Verdict:** holds for the new code (`packages/cli/src/enterprise/server-store.ts`).

`checkExistingKey` gives one of four verdicts on a key config.yaml already holds for the server; `unknown` (503, a network error, a timeout, two entries) stops the run before any sign-in. `connectServerStore` copies config.yaml (owner-only) before core's `registerEnterpriseServer` writes the key, then refreshes the scopes; a failure after the write puts the copy's exact bytes back through `writeConfigFile`, and a refused registration (B5's takeover refusal among them) writes nothing.
- Theorems (`Store`, Login.lean §4): `key_written_at_most_once`, `unknown_stops` (review focus 1: no mint, no write), `failure_unchanged` and `connect_failure_unchanged` (any outcome but `stored` leaves the config as it was), `stored_only_after_ok`, `works_no_mint`, `stored_reachable`, `rollback_reachable`.
- Counterexamples: `naive_blip_overwrites` (reading "no verdict" as "the key does not work" mints a new key and overwrites one that may still work during a server blip), `late_backup_keeps_key` (a rollback to a copy taken after the write keeps the new key).
- Replays: `enterprise-server-store.test.ts` "transient /me failure keeps the key and stops", "503 … → unknown", "a failure after the key was written is rolled back: config.yaml is byte-identical", "B5: a takeover … nothing is written".
- Mutation checks (each reverted; each breaks the build): the failure branch keeping the written config (`m5`) breaks `connect_failure_unchanged`, `rollback_reachable` and `late_backup_keeps_key`; `unknown` signing in like the other verdicts (`m6`) breaks `unknown_stops`, `failure_unchanged`, `stored_only_after_ok`, `key_written_at_most_once` and `naive_blip_overwrites`; a reused key also minting (`m7`) breaks `works_no_mint` and `rollback_reachable`. In the code: removing the rollback turns the two rollback tests red; reading `unknown` as `rejected` turns the two `unknown` tests red.
- Not modelled: another process writing config.yaml between the copy and a rollback (the rollback would undo that write too). The rollback runs under the config lock, but the copy is taken before registration takes it.

## Not verified

- A real server: the device endpoints are tested through a scripted fetch and an in-test server with the C3 shapes (the enterprise contract stub's), not the A8 server.
- Windows: the backups of config.yaml and config.json go through the cleanup's `backupWriter` and core's `protectOwnerOnly` (owner-only access list, verified; tested with icacls mocked). A real Windows run of `plur login` is not part of this PR.
- SIGTERM or a kill during the write itself: the write is synchronous and atomic (temp file and rename), so config.yaml is old or new, but a lock file could be left; not tested here.
- The installer's store step on real Windows: the key file protection and the backup go through core's `protectOwnerOnly` (tested with icacls and whoami faked; core's own Windows CI test runs the real tools). No caller runs `connectServerStore` yet: `plur-enterprise init` (plan C task 10) wires it.
