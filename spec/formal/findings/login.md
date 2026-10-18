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

## Not verified

- A real server: the device endpoints are tested through a scripted fetch and an in-test server with the C3 shapes (the enterprise contract stub's), not the A8 server.
- Windows: the backups of config.yaml and config.json are made with mode 0600/0700, which Windows does not enforce; the owner-only ACL helper (B1b) is not merged yet.
- SIGTERM or a kill during the write itself: the write is synchronous and atomic (temp file and rename), so config.yaml is old or new, but a lock file could be left; not tested here.
