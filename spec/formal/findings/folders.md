# Findings — Folders (folder map, #1347; cluster 4 of the field-report pass)

Model: `PlurSpec/Folders.lean` (namespace `PlurSpec.Folders`), covering
`packages/core/src/folders.ts` and `trust.ts`, plus `canonicalize` from
`project-config.ts` and the remote gate in `project-remote.ts`. Checked with
`cd spec/formal && ~/.elan/bin/lake env lean PlurSpec/Folders.lean` (exit 0, no
`sorry`/`admit`/`axiom`/`native_decide`).

Replays: `packages/core/test/formal-fr-c4-folders.test.ts`, run with
`cd packages/core && PLUR_PATH=<scratch> npx vitest run test/formal-fr-c4-folders.test.ts`
→ **13 passed**. Every test builds its own home and PLUR root in a temp dir and
sets `HOME` to it; the real `~/.plur` is never touched.

Per the brief override, no `packages/*/src` file was edited. Each confirmed defect
is pinned by a test named `NEEDS-OWNER evidence: …` that asserts the CURRENT
behaviour. Flip the assertion when the owner decides.

Context: design note r3 (`docs/specs/2026-09-28-folder-map-design.md` on
`origin/docs/field-report-triage`); owner decision D1 "ignore-ask"
(`docs/audits/2026-09-29-formal-decisions.yaml`, read from commit `57cd09b5`
because the file is not on this branch).

What the model leaves out: glob matching, `~` expansion and win32 case folding are
abstracted. Each entry carries booleans for "covers the folder, loose match",
"covers it, strict match" and "covers the `.plur.yaml` directory". §2 models the
fail-closed compare on its own, on segment lists. Specificity is flattened to one
`Nat`. The `.git` walk boundary is treated as an input (`yaml` vs `marker`). The
case-only merge in `findEntryIndex` (#1357) is not modelled.

## 1. Resolution (`resolveFolderPolicy`) — REFUTED (the claims hold and are proved)

- **Off always wins.** `off_wins`: any `off` entry that matches loosely gives `off`,
  whatever the map, `.plur.yaml` or MCP config say. `off_only_from_map` is the
  converse, under `WF` (a strict match implies a loose one, true in the code:
  `lax = [strict[0], …]`, and the strict forms are a subset of the loose ones).
  Step 4 can never give `off` on its own (`step4_not_off`).
- **Total and deterministic.** `resolve` is a total Lean function of (map,
  `.plur.yaml`, marker). `resolve_branches` lists its four outcomes. `tie_later_wins`
  pins the tie rule. `unmapped_asks`: an unmapped folder with no marker, `$HOME`
  included, gives `ask`. In the code, every read on this path
  (`loadFolderMap`, `readProjectConfigFromPath`, `canonicalize`) catches its own
  errors, so the resolver does not throw. That comes from reading the code; it
  was not checked separately.
- **A map scope beats a `.plur.yaml` hint.** `map_scope_overrides_hint`;
  `trusted_hint_applies` covers the case with no map scope (non-vacuity).
- **D1: an untrusted `.plur.yaml`'s requests never apply.**
  `untrusted_request_never_applies`: the result's scope is `none` or the map's
  scope, never the file's, and `remoteAllowed = false`. `untrusted_asks`: with no
  map decision for the folder, the result is `ask` with `reason:
  'untrusted-plur-yaml'`.
- **The remote needs a covering trusted entry.** `remote_needs_trust`: the file
  must give both `remote_url` and `remote_token`, and some entry must be
  `trusted` and cover the file's directory.
- Non-vacuity: `trusted_remote_example`, `untrusted_example`.
- Replay (all pass): "off wins over a trusted .plur.yaml with a remote…", "a map
  scope beats a trusted hint", "an untrusted request is never applied; with no map
  decision it asks", "the remote is allowed only with a covering trusted entry".
- Mutation check: M1 (off test removed) breaks `off_wins` and
  `resolve_branches`. M2 (hint applied when untrusted) breaks
  `untrusted_request_never_applies`. M3 (remote without the trust check) breaks
  `remote_needs_trust`.

Observation, not a defect: when a folder has an untrusted, requesting
`.plur.yaml` AND a project MCP config, the result is `ask` rather than step 3's
`on`. That is the D1 question firing. It is more restrictive, and it matches the
design's Q-A.

## 2. Fail-closed trust compare (symlink swaps) — REFUTED (holds, proved)

- `strict_iff`: a folder is trusted exactly when some grant, **as stored**, is a
  lexical prefix of the folder's canonical path.
- `link_invariant`: trust depends only on the canonical location. A link *into*
  a trusted tree is trusted.
- `canonical_grant_trusted` (non-vacuity): `plur trust` stores the canonical
  path, and that path is trusted.
- Swap cases: `swap_target_refused` (the trusted folder is replaced by a link to
  a clone) and `swap_parent_refused` (its parent is replaced by a link, for both
  the old path and the clone's own path). `swap_target_lax_accepts` and
  `swap_parent_lax_accepts` show that resolving the stored entry at compare time
  (the `off` rule's loose forms) WOULD accept both swaps. So strict matching for
  trust is load-bearing.
- Replay: "the trusted folder swapped for a symlink to a cloned repo is not
  trusted", "the trusted folder's PARENT swapped…", "a link INTO a trusted tree is
  trusted". All three pass.
- Mutation check: M4 (strict forms also canonicalise the stored entry) breaks
  `strict_iff` and `swap_target_refused`.

**Docstring drift (NEEDS-OWNER, one line in `trust.ts`, not mine to edit):** the
`isDirectoryTrusted` docstring says stored entries are "matched as written or with
their parent canonicalised". Since #1334 the trust check uses only the as-written
form (`entryForms(…, lax=false)`). Only `off` also canonicalises the parent, and
folders.ts' own comment says canonicalising it would follow a planted symlink.
Should the `trust.ts` docstring be corrected to "matched as written (fails
closed)"?

## 3. Trust dual-write — CONFIRMED + NEEDS-OWNER (2 defects)

The model's invariant `Inv`: every live `trust.yaml` grant has a trusted map entry
for the same folder behind it. Without that, a downgrade (an adapter on the
previous core, which is why the dual-write exists) or a re-import (folders.yaml
lost) brings back a grant the user revoked. The existing test "folders set
--trusted / --no-trusted are seen by the old reader; a re-import agrees" pins
this intent.

Proved: `grant_keeps_inv` and `grant_both` (a grant lands in both files).
`untrust_fix_keeps_inv`, `rm_fix_keeps_inv` and `untrust_fix_revokes` show the
proposed fixes keep `Inv`.

**(a) `plur folders rm` of a trusted folder leaves the `trust.yaml` grant.**
`removeFolderEntryUnlocked` saves folders.yaml but never calls
`removeLegacyTrustEntryUnlocked`. Theorem `rm_breaks_inv`. Replay "NEEDS-OWNER
evidence: `plur folders rm` of a trusted entry leaves the trust.yaml grant":
after `rm`, `isDirectoryTrusted` → false, the old reader → **true**, and
`trust.yaml` still lists the folder. After `rm folders.yaml`,
`isDirectoryTrusted` → **true** again.

**(b) A `~`-spelled grant survives `plur untrust`.** A hand-written entry `path:
~/src/team-repo` (the design note's own example) keeps its spelling when `plur
trust` sets `trusted`. The dual-write therefore writes `~/src/team-repo` into
trust.yaml. `removeLegacyTrustEntryUnlocked` compares only `folder`, `raw` and
`target` as literal strings, so the shell-expanded path never matches the
`~/…` line. The map is cleared, and `untrustDirectory` reports `true`. Theorem
`tilde_breaks_inv`. Replay "NEEDS-OWNER evidence: a `~`-spelled grant survives
untrust…": trust.yaml still holds `~/src/team-repo`, and after `rm folders.yaml`
`isDirectoryTrusted` → **true**. The same literal compare misses a line in
another letter case (written by the pre-#1357 case-preserving `canonicalize`).
That case is not replayed here.

`fixes_close_both`: removing trust.yaml lines with the map's own matcher (the
entry forms, as `findEntryIndex` uses), in both `untrust` and `folders rm`,
restores `Inv`. Mutation check: M5 (`rm` touches the map only) breaks
`rm_fix_keeps_inv`. M6 (untrust with the literal compare) breaks
`untrust_fix_keeps_inv`.

Question for the owner: should `plur folders rm` of a trusted entry, and `plur
untrust`, also remove the trust.yaml line by the map's matcher, so the
`~`-spelled and mis-cased lines go too? The options:
- (1) yes, both, as modelled;
- (2) also stop importing `~` lines from trust.yaml (the old reader never
  honoured them);
- (3) accept the gap until the dual-write is retired.

This touches persisted state (trust.yaml) and the downgrade path, so it is the
owner's call.

## 4. Nonces — REFUTED for the stated rules; CONFIRMED + NEEDS-OWNER for "once"

Proved:
- `nonce_one_folder`: anything saved names the nonce's own folder.
- `refused_keeps_nonce`: an unknown or other-folder nonce, or a failed save,
  changes nothing and does not burn the nonce.
- `consumed_after_save`: the nonce is consumed only after a successful save.

Replays "a nonce names one folder and authorises one write" and "a refused write
does not burn the nonce" pass. Mutation check: M8 (accept any issued nonce, for
any folder) breaks `nonce_one_folder`.

**Defect:** the code consumes the nonce only after BOTH folders.yaml and the
trust.yaml dual-write succeed. When the trust.yaml write throws after
folders.yaml was saved, the caller sees an error, the map change stays, and the
nonce stays live. A second write with the same nonce is then accepted and saved.
Theorem `legacy_fail_two_writes` (two saved writes from one nonce).
`fix_once` and `fix_one_write` show that consuming right after the map save makes
the nonce single-use. Replay "NEEDS-OWNER evidence: a failed trust.yaml write
after a saved map leaves the nonce live for a second saved write": trust.yaml is
made a directory so the atomic rename fails. Write 1 (`--on --trusted`) throws
but is saved. Write 2 (`--off`) with the same nonce is accepted and saved. Both
writes name the asked folder, so a nonce still cannot reach another folder.
Mutation check: M7 (consume only after the legacy write) breaks `fix_once` and
`fix_one_write`.

Question for the owner: should the nonce be consumed as soon as folders.yaml is
saved, so a failed dual-write needs a fresh ask? Or is a same-folder retry with
the same nonce after a partial failure acceptable?

## Files

- New: `spec/formal/PlurSpec/Folders.lean`; this file;
  `packages/core/test/formal-fr-c4-folders.test.ts`.
- Appended: `import PlurSpec.Folders` in `spec/formal/PlurSpec.lean`; the
  `PlurSpec/Folders.lean` entry in `spec/formal/verify.yaml` (folders.ts,
  trust.ts, project-config.ts, project-remote.ts).
