# Findings: Trust (`packages/cli/src/enterprise/{ca,launch-env,exec,wire}.ts`, #1638)

The model is `spec/formal/PlurSpec/Trust.lean`. It checks cleanly with `lake env lean PlurSpec/Trust.lean`: no sorry, axiom or native_decide. Written with the code (plan C task 2), 2026-10-18, so every section models the shipped code; the counterexamples are for the bugs the code is shaped to prevent.

Abstract: certificates and fingerprints (`fp` is any function; the real one is SHA-256 of the DER), the certificate sources, and the "carries credentials" and "has a line break" predicates. Left out: PEM/DER parsing, the platform store commands (their output is one more source list), and what an editor does with the env.

## T1. Trust only ever grows by the pinned CA

`NODE_EXTRA_CA_CERTS` is modelled by its effect: Node trusts its default roots followed by the file's certificates. `install` (`installCompanyCa`) writes exactly one certificate, the one whose fingerprint equals the pin, and a refusal writes nothing.

- `Anchor.find_sound`: what `findCompanyCa` returns carries the pin and came from the sources.
- `Anchor.install_only_pinned`: a success writes `[c]` with `fp c = pin`.
- `Anchor.defaults_kept`: every default root stays trusted, on success and on refusal (the CA is added, never a replacement).
- `Anchor.growth_only_pinned`: anything trusted after the run is a default root, was in the earlier file, or carries the pin.
- `Anchor.refusal_writes_nothing`, `Anchor.invalid_pin_refused`.
- `Anchor.unprotected_writes_nothing`: when the file cannot be made owner-only before it is filled, nothing is written (reason `unprotected`).
- Non-vacuity: `Anchor.install_reachable` (the pinned CA, found in a bundle next to another, is installed alone).

## T2. A mismatching CA is never trusted; the caFile is checked again

- `Anchor.mismatch_never_trusted`: a certificate whose fingerprint differs from the pin, and that was not trusted before, is not trusted after, wherever it came from.
- `Anchor.caFile_not_bypassed`: a caFile with no match is `mismatch`, even when a system store holds the pinned CA.
- Counterexample `Anchor.bundle_trusts_neighbour`: writing the whole caFile bundle once any block matches would trust the neighbour. Replayed by `enterprise-ca.test.ts` "a bundle caFile installs ONLY the pinned certificate".
- Counterexample `Anchor.replace_loses_defaults`: a replacing trust file (SSL_CERT_FILE-style) drops the default roots.

## T3. Verification never disabled; no credential in the tool env

- `LaunchEnv.keys_allowed`: every key written is in `TOOL_ENV_KEYS`.
- `LaunchEnv.no_tls_switch`: NODE_TLS_REJECT_UNAUTHORIZED, SSL_CERT_FILE and a token key can never be in the env.
- `LaunchEnv.no_credentials`: no proxy address with a user name or password is written.
- Non-vacuity: `LaunchEnv.build_reachable` (the plan's example).
- Counterexample `LaunchEnv.nocheck_writes_credentials`: copying the proxy address as it is puts a password into every editor config. Replayed by `enterprise-launch-env.test.ts` "a proxy address with a user name or password is refused".

## T4. The real exec adapter: only a real exit 0 reads as 0

The shared `ExecFn` now carries `{ env, timeoutMs, input }` (it used to be declared only in `launch-check.ts`, and the plan's narrower type would have let a real adapter drop env and timeout).

- `Exec.zero_means_exit_zero`, `Exec.timeout_nonzero`, `Exec.exit_reachable`.
- Counterexample `Exec.naive_timeout_is_success`: `r.status ?? 0` reads a killed command as success. Replayed by `enterprise-exec.test.ts` "a timeout is a non-zero status, not null".

## T5. Wiring each tool (`wire.ts`, plan C task 5, 2026-10-18)

- Only PLUR's launch keys change in a tool's `plur` entry: `Wire.user_keys_kept`, `Wire.plur_keys_set`, `Wire.foreign_refused`, `Wire.rerun_unchanged`, non-vacuity `Wire.apply_reachable`. Counterexample `Wire.replace_drops_user_key`: writing the env as one whole value (what the shared Codex patcher does for `env`) drops the user's own `PLUR_PATH`. Replayed by `enterprise-wire.test.ts` "keeps the user's own env keys and comments, removes a PLUR key that is now absent". The code backs the model with a re-parse: an edit whose parsed result differs from the model's env anywhere is refused.
- The proof gets only a direct launch: `Wire.proof_kill_ends_server`; counterexample `Wire.naive_orphans` (an npx or cmd.exe launch handed to the proof can leave the server running after the kill). Replayed by the `launchProblem` tests and "lists only tools with a plur entry or on the other side, with a launch only when it is direct".
- The WSL probe runs at most `<root>\System32\wsl.exe` for a validated root, and nothing off Windows: `Wire.runs_only_system32`, `Wire.off_windows_runs_nothing`, `Wire.probe_reachable`; counterexample `Wire.naive_runs_planted` (a SystemRoot on a share). WSL is the kernel release alone: `Wire.wsl_env_irrelevant`. Replayed by the `probeWsl` tests (a share, a user folder, `..` and unset SystemRoot run nothing; `WSL_DISTRO_NAME` does not make plain Linux WSL).
- The other-side wording carries the side (owner decision O10): `Wire.side_text_distinct`, `Wire.other_side_only_when_absent_here`; counterexample `Wire.old_text_wrong_inside_wsl`.
- Gate update (2026-10-18): `Launcher` is the classifier's output, and the classifier is not modelled. It is now an allowlist in code (`isDirectLaunch`: `plur-mcp`, or Node running a script that is not a package runner's), so `.direct` means "PLUR itself" rather than "none of npx, shell, .cmd"; the theorems are unchanged. The audit found spellings the old blacklist passed (`env -u X bash -c`, `bun x`, `node …/npx-cli.js`); they are replayed by the `launchProblem: only PLUR itself is a direct launch` tests. `applyMcpEnv` also applies the launch-env value rules (no proxy credentials, no line break), the same `LaunchEnv` rules as `buildToolMcpEnv`. `ExecFn` can return stderr when asked; the status mapping (`Exec.*`) is unchanged.

## Mutation checks

Each run on a scratch copy of the model; every mutation breaks the named theorems and nothing else had to change.

| Mutation | Breaks |
|---|---|
| `find` accepts any certificate (`if true`) | `find_sound`, `install_reachable` |
| success replaces the defaults (`.ok f => f`) | `defaults_kept`, `growth_only_pinned` |
| caFile mismatch falls back to the system stores | `caFile_not_bypassed` (and `install_only_pinned`'s proof) |
| credential check removed from `build` | `no_credentials` |
| `build` also emits NODE_TLS_REJECT_UNAUTHORIZED=0 | `keys_allowed`, `build_reachable` |
| timeout mapped to 0 | `zero_means_exit_zero`, `timeout_nonzero` |
| `install` ignores `protectable` | `unprotected_writes_nothing` |
| `merge` takes every key from the new env | `user_keys_kept`, `rerun_unchanged`, `apply_reachable` |
| `apply` skips the foreign-key refusal | `foreign_refused` |
| `forProof` passes an npx launch | `proof_kill_ends_server` |
| `probeRun` skips `validRoot` | `runs_only_system32` |
| `probeRun` also runs off Windows | `off_windows_runs_nothing`, `runs_only_system32` |
| one text for both sides | `side_text_distinct` |
| `side` ignores Codex found here | `other_side_only_when_absent_here` |

## Review update (2026-10-18)

Gate review of the PR. The model gained `Input.protectable`, the `unprotected` reason and `Anchor.unprotected_writes_nothing`; the search is now `select` and `install` wraps it, so the existing theorems hold unchanged. The code changes it follows: `company-ca.pem` is written through an exclusive temp file made owner-only while empty (0600, or a verified owner-only icacls list on Windows); the Windows store export runs `<SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe` only for a SystemRoot of `<drive>:\Windows`, with a plain .NET script; macOS runs `/usr/bin/security`; a proxy value with whitespace, a control character or any `@` is refused; an exec rejected before start is `startFailed` (127); the exec timeout kills with SIGKILL; icacls for the CA file runs as `<SystemRoot>\System32\icacls.exe`; the PEM scanner keeps only complete blocks and is linear. Not modelled: the path and script choices (they decide which program runs, not what is trusted).

## Not verified

- A real TLS handshake through `NODE_EXTRA_CA_CERTS` and a real proxy: the model assumes Node's documented behaviour (added roots, and `NODE_USE_ENV_PROXY=1` from Node 22.21/24.0, measured for the remote store in the B17 work). The editor-level proof is plan C task 5/7.
- The Windows PowerShell export and the macOS `security` output: tested through a fake exec only; settled by a Windows and macOS CI run of the install smokes.
