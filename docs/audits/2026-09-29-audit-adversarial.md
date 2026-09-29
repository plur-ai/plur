# Adversarial audit: integration/field-report-2026-09-29 (baf6df61) vs main

Pass 2 of 3 (adversarial). This is a blind pass: other passes' reports were not read. The target is `origin/integration/field-report-2026-09-29` at `baf6df61`, diffed against `origin/main` (`524530e0`). That covers 114 files, +11,309 / −535.

Method: the precedent is `2026-08-03-fix-diff-adversarial.md` and the lesson of `2026-08-13-post-merge-audit.md`, which was to hunt for code that reports success while doing the wrong thing. A finding counts only if it was reproduced against the built code of this branch. Every run used a throwaway script with a temporary `HOME` and `PLUR_PATH`, and real TCP for remote stores. The real `~/.plur` was never touched. To compare old against new behaviour, `origin/main` was built in a second worktree. Nothing was fixed or committed.

The repro scripts were kept alongside this report in the audit scratch area. The key ones are inlined below. `server.mjs` is a minimal remote store (`/api/v1/me`, `POST/GET /api/v1/engrams`, feedback). It can honour `Idempotency-Key` the way `docs/remote-store-contract.md` (new in this branch) tells servers to.

**11 findings: 2 High, 4 Medium, 5 Low. No Critical.** Two of them, H1 and H2, stay latent until a server implements the new contract. They are rated High because the branch publishes that contract and asks servers to implement it.

---

## High

### H1. Every direct team write sends the same `Idempotency-Key: __pending__`. A server that follows the new contract turns every write after the first into the first one, and the client still reports `delivery: "remote"`.

- `packages/core/src/index.ts:3712`: `learnRouted` posts `localPlaceholder`.
- `packages/core/src/index.ts:3903`: `_buildEngramShape` gives that placeholder `id: '__pending__'`.
- `packages/core/src/store/remote-store.ts:779`: `'Idempotency-Key': engram.id`.
- `docs/remote-store-contract.md` (new) tells servers: "for a key it has already accepted from the same token, return the original response (status and `id`) instead of creating a second engram".

Repro (`r1-idem.mjs`: one Plur, a url store for `group:acme/eng`, and a server honouring the key as documented):
```js
const a = await plur.learnRouted('Deploys go out on Tuesdays only', { scope: 'group:acme/eng', type: 'behavioral' })
const b = await plur.learnRouted('Staging database is reset every night at 02:00', { scope: 'group:acme/eng', type: 'behavioral' })
```
Actual:
```
POST keys sent: [ '__pending__', '__pending__' ]
A: SRV-1 "Deploys go out on Tuesdays only" { delivery: 'remote' }
B: SRV-1 "Staging database is reset every night at 02:00" { delivery: 'remote' }
server stored rows: [ [ 'SRV-1', 'Deploys go out on Tuesdays only' ] ]
```
Expected: each create carries a key unique to that write, as the contract itself requires ("different for different writes"). B is stored as `SRV-2`.

Actual: B never reaches the server. `plur_learn` reports `delivery: "remote"` with B's statement and A's id, and nothing is kept locally. With a server that ignores the header, as all of them do today, nothing goes wrong, so every existing test passes.

### H2. The outbox uses the local engram id as its `Idempotency-Key`, and that id is not unique across machines that share a token. The second machine's queued write is reported flushed, its local copy is removed, and the server never stores it.

- `packages/core/src/index.ts:8505`: the flush posts `cleanEngram`, whose id is the local id.
- `remote-store.ts:779`.

Local ids are `ENG-<date>-NNN` per store. The first queued write of the day is `ENG-2026-09-29-001` on every machine. One person with a laptop and a desktop, both registered with the same token (`plur stores add --token-env`), is the ordinary case.

Repro (`r2-crossmachine.mjs`: two `PLUR_PATH`s with the same token; the server answers 503 while the writes are queued, then 201 with the key honoured):
```
queued ids: ENG-2026-09-29-001 ENG-2026-09-29-001 outbox outbox
laptop flush:  {"flushed":1,"failed":0,"deferred":0,"held":0,"skipped":0,...}
desktop flush: {"flushed":1,"failed":0,"deferred":0,"held":0,"skipped":0,...} desktop outbox left: 0
keys: [ '__pending__', '__pending__', 'ENG-2026-09-29-001', 'ENG-2026-09-29-001' ]
server rows: [ [ 'SRV-1', 'Laptop: the VPN config lives in infra/vpn' ] ]
```
Expected: the desktop engram is stored as a second row.

Actual: the desktop reports `flushed: 1` and its outbox is empty, but the engram is on neither machine nor the server. That is data loss, reported as delivery. The key needs to be globally unique, for example a random UUID minted once when the write is queued and kept in `_outbox`.

---

## Medium

### M1. Trust is now kept in two places that never meet again. `plur untrust` does not revoke trust for adapters on the previous core, and `plur trust` grants are invisible to them, even though the CLI tells the user the grant "will now be honored by … the opencode plugin".

- `packages/core/src/folders.ts:255-270`: `trust.yaml` is imported once, when `folders.yaml` is missing, and never written again.
- `trust.ts:46-57`: grants and revocations touch only `folders.yaml`.
- `packages/cli/src/commands/trust.ts:83`: the message quoted above.

The one adapter that checks trust is the opencode plugin (`packages/opencode/src/scope.ts`). It is on its own version track, and `npm view @plur-ai/opencode` shows it pins `"@plur-ai/core": "0.20.1"`, which is the exact pre-folder-map core. That pin only moves when the plugin is republished with `--opencode`.

Repro (`r4-untrust.mjs` and `r4b-trust.mjs`; OLD is `origin/main` core 0.20.1, NEW is this branch):
```
# trusted under 0.20.1, then `plur untrust <repo>` with the new CLI:
new CLI untrust: {"success":true,"removed":true}
new core isDirectoryTrusted: false
trust.yaml after untrust: trusted: [ <repo> ]          # still listed
previous-release core isDirectoryTrusted: true          # still trusted there
# the other direction:
new CLI `plur trust <repo2>` → success; trust.yaml exists: false | folders.yaml exists: true
core 0.20.1 isDirectoryTrusted: false
```
Expected: a revocation revokes everywhere, and a grant is not advertised to an adapter that cannot see it. Either keep `trust.yaml` in sync on every write, or bump and republish the plugin with this core and say so in the changelog.

Actual: the security command claims success while the only trust-checking adapter keeps honouring the revoked directory's `.plur.yaml` remote.

### M2. `hook-inject` now copies every prompt to `$TMPDIR/plur-sessions/<session>.task`. The file is world-readable, the directory is not hardened, and the write follows a planted symlink.

- `packages/cli/src/commands/hook-inject.ts:222-229`: `sessionDir()` uses `mkdirSync` with default modes and has no owner or symlink check.
- `:512` and `:646`: `writeFileSync(taskPath, prompt)` runs on every prompt. The `.task` file is new in this branch; before, only the first prompt reached the marker.

The same repo already hardens its other session directories (`ensureSessionDir` in `lib/codex-hook-io.ts:110`: 0700, uid and symlink checks). This directory was not hardened.

Repro (a fake `TMPDIR`, as the same user):
```
drwxr-xr-x  faketmp/plur-sessions
-rw-r--r--  faketmp/plur-sessions/sess-1.task
# replace sess-1.task with a symlink to ../victim.txt, then send the next prompt:
victim.txt now: second prompt: the prod DB password is hunter2
```
Expected: 0700 directory, 0600 files, and `O_NOFOLLOW` or an lstat check, the same as `ensureSessionDir`.

Actual: on Linux, `$TMPDIR` is usually the shared `/tmp`. Any local user can read every user's latest prompt. A user who pre-creates `/tmp/plur-sessions` can also list session keys and redirect the per-prompt write through a symlink to clobber any file the victim can write. On macOS, `$TMPDIR` is per-user, so the exposure is limited to the same user.

### M3. Auto-capture honours an untrusted `.plur.yaml` scope, so an unattended hook pushes captured text into a team remote store.

- `packages/cli/src/lib/auto-rate.ts:173-183`: `readProjectConfig(opts.cwd).scope` is passed straight to `learnRouted`. There is no `isDirectoryTrusted` or `resolveFolderPolicy` check.

This is opt-in, and only runs with `PLUR_AUTO_CAPTURE=1`.

Repro (`r5-capture.mjs`): the user has a url store for `group:acme/eng`. A freshly cloned, never-trusted repo has `.plur.yaml` `scope: group:acme/eng`. The hook `hook-auto-rate claude` fires with a reply containing a "🧠 I learned:" bullet.
```
repo trusted? false
team store received: [ [ 'group:acme/eng', 'My personal notes about the contractor dispute live in ~/private/dispute.md', 'claude:auto-capture' ] ]
```
Expected: this is a new write path with no human in the loop, so it should take a repo's scope only when the directory is trusted. Otherwise the scope should be local.

Actual: the repo chooses where the agent's own reply text is published. A prompt injection in the repo can also shape the "I learned" bullets. The MCP `session_start` also reads `.plur.yaml` without trust, but that is pre-existing and needs an agent call. This path is new and unattended.

### M4. The folder-map nonce gives no protection: leaving it out is accepted from a non-interactive caller.

- CLI `packages/cli/src/commands/folders.ts:20-23` and `:81`.
- Core `folders.ts:469-470`: the nonce is checked only `if (opts.nonce !== undefined)`.

The doc comment says a write without `--nonce` "is your own action". Nothing checks that, and there is no TTY test anywhere in the diff.

Repro (`r9-nonce.mjs`: stdin and stdout are pipes, as when an agent runs a command in a clone whose `.plur.yaml` has `remote_url` and `remote_token`):
```
before: {"mode":"on",...,"remoteAllowed":false}
with a forged nonce:  exit 1 {"code":"nonce-unknown"}
with no nonce at all: exit 0 {"success":true,"entry":{...,"trusted":true}}
after:  {"mode":"on",...,"remoteAllowed":true}
```
Expected: a write from the ask flow must present its nonce, and a write that claims to be "by hand" is refused when stdin is not a TTY, at least for `--trusted`.

Actual: the agent that the nonce is meant to constrain simply omits it. `plur trust` had the same gap before this branch. The new mechanism does not close it, although it is documented as if it did. The design note named in the `folders.ts` header, `docs/specs/2026-09-28-folder-map-design.md`, does not exist in the repo.

---

## Low

### L1. Concurrent folder-map writes lose updates while every writer reports success. This includes `plur trust` and `plur untrust`.

`folders.ts:457-485`: `setFolderEntry`, `removeFolderEntry` and `clearFolderTrust` each read, modify and `atomicWrite` the file with no lock.

Repro: run 12 `plur folders set <dN> --off --json` in parallel on one `PLUR_PATH`.
```
12 × {"success":true}   entries recorded: 5
```
A concurrent `plur trust A` can resurrect a grant that `plur untrust B` just removed. The `trust.yaml` path on main had the same unlocked read-modify-write for trust alone. This branch extends it to on/off/scope as well.

### L2. `plur sync` says nothing about queued writes when all of them are held as `needs_action`.

`packages/cli/src/commands/sync.ts:55` and `lib/hook-outbox-flush.ts:159`: the report condition checks flushed, failed, deferred and skipped, but not `held`.

Repro (`r3-held.mjs`: two writes refused with 403, then `plur sync` in a pty and with `--json`):
```
Sync: up-to-date
  No changes to commit. ...
{"action":"initialized",...,"full":false}        # no "outbox" key
```
Meanwhile `plur outbox` shows `2 write(s) queued: 0 will retry, 2 need action.`

Expected: per the file's own comment ("Undelivered writes are an outcome that differs from 'synced' — never suppressed"), the still-queued line is printed. Session start, `plur status` and doctor do report these writes, so the impact is limited to `sync` and the hook's stderr line.

### L3. The secret guard misses two Slack token prefixes.

`packages/core/src/secrets.ts:35` matches only `xox[abprs]-<digits>-…`. Slack app-level tokens (`xapp-1-…`) and rotation refresh tokens (`xoxe-1-…`) pass.

Repro (`r7b.mjs`):
```
STORED  ENG-2026-09-29-001 Slack token for the bot is xapp-1-A012ABCD3EF-1234…
REFUSED Secret detected in statement or context: slack_token   (xoxb control)
```
The comment also calls `xoxr-` "refresh", but Slack's rotation refresh tokens use `xoxe-`. There is also a minor false negative: a token glued after a digit (`1ghp_…`) is not detected, because of the lookbehind.

### L4. A parent directory swapped for a symlink redirects a trust grant. This is a regression from main.

`folders.ts:176-195` (`entryForms`) canonicalises the entry's parent at check time. The comment says the leaf is left unresolved "so a symlink swapped in for a trusted folder" is not followed, but a swap one level up is followed.

Repro (`r10-swap.mjs`: trust `base/real/proj`, then `mv real real.orig && ln -s evil real`):
```
branch | evil/proj trusted? true  (before swap: false)
main   | evil/proj trusted? false
```
Rated Low because the attacker needs write access to the trusted directory's parent. For a trusted subdirectory of a git repo, a malicious commit can supply that (by committing the parent as a symlink), but that attacker could already edit the trusted tree's `.plur.yaml`.

### L5. `stores add --url` scrubs the token only as an exact string, so an encoded echo is printed.

`packages/cli/src/commands/stores.ts:60` and the core `addRemoteStore` `scrub`. The code comments promise that "the token is never printed: not in text output, not in --json, not in an error".

Repro (`r12-token.mjs`: the server answers `/me` with a 401 whose body echoes the token both raw and URL-encoded):
```
"rejected the token (Remote /me failed: 401 invalid token [redacted]; also plr_SECRETSECRET%2F%2B%3Dvalue)"
```
The server already holds the token. The leak is into terminal, CI and agent-transcript output.

---

## Tried and held

- **Capability gate for automatic feedback (#1310).** The server did not advertise `feedback.source`. `feedback(id,'negative',scope,{source:'auto'})` was refused with the documented message. The unscoped call did not reach the remote. The server received 0 feedback POSTs (`r6-cap.mjs`).
- **`stores add --url` refusals.** A rejected token (401) and a scope the token is not authorised for both wrote nothing to `config.yaml`. The exact token string was redacted, and a valid add plus re-run gave `added` then `already_registered` (`r12-token.mjs`).
- **Forged folder nonce.** Refused with `nonce-unknown`, and nothing changed. The problem is omission; see M4.
- **Secret guard true positives and prose.** GitHub classic, fine-grained and in JSON; GitLab legacy, routable and in URL credentials; Slack `xoxb`; npm; Stripe `rk_live_`; AWS `ASIA` were all detected. The prose "use a ghp_ token" and "a xoxb-style token" were not flagged (`r7-secrets.mjs`).
- **Trust grant on the pre-swap state.** `evil/proj` is not trusted before any swap, on both branch and main.
- **`needs_action` classification.** Two 403 refusals were classified `needs_action` with a correct reason and next step, and were held rather than re-dialled by the automatic flush.

## Not exercised (no repro, so no claim)

- The #1313 abandoned-hybrid wait and empty-lock race.
- The watchdog ceiling under a slow embedder.
- Windows quoting, the `node.exe` MCP entry heal, the Codex TOML reader.
- The opencode config-dir move.
- `plur-mcp init` hook healing against real user settings.
- Copy-on-promote (#1268) with remote team stores.
- In-doubt probe paging against a server that omits `total_count`.
