# Findings: secrets-install

Model: `spec/formal/PlurSpec/SecretsInstall.lean` (checks clean, no sorry). Inventory
changes: `findings/secrets-install-inventory.yaml`.

## Lead 1: instruction-section upgrade decision (INS-1 install idempotence): PROVED

Modelled `matchShipped`, the heading walk in `upsertInstructionSection` (`scanF`) and
the rebuild loop (`step`/`rebuild`), branch for branch. The heading test and the
"current marker before the next boundary" test are oracles.

- `match_is_shipped`: a match of length n means the n lines are, line for line under
  `cmp`, one shipped text.
- `edited_not_matched`: one edited line in every candidate span means no match.
- `unmodified_shipped_matched`: an unmodified shipped text is always matched (at
  least its own length; the longest one wins).
- `user_text_kept` / `upgrade_keeps_user_text`: every non-blank line outside a shipped
  span survives the rebuild, in order; every span the scan marks is shipped text.
- Reachability: `shipped_upgraded`, `edited_kept`, `appended_text_kept` (by `decide`).

Left out, stated in the file: the code records a found section at every heading, even
inside an earlier shipped match. Overlapping matches still only cover shipped lines.
The separator blank line is inserted always in the model, not only when text follows.
Blank lines next to a removed section are dropped (whitespace only).

Replay against the real code
(`node --experimental-strip-types scratchpad/replay-ins.mts`):
`shipped: upgraded`, `edited: added` (the edited section kept, the new one added beside it),
`appended: upgraded … my extra line` (kept), `two-copies: upgraded … between … end`.
These match the model's examples.

Mutations (each broke the proof): M1 prefixMatch accepts lines shorter than the text;
M2 first span drops the lines before it; M3 stale copy drops the lines before it;
M5 empty shipped texts not filtered; M6 every line after a span skipped (not only
blanks); M7 match by first line only.

## Lead 2: secrets.ts scan and refusals: PROVED + TESTED (2 unbacked rules now backed)

- `matchInternalHost` (the loop always advances): `nextIndex_advances`, `loop_terminates`
  (ends within len+2 iterations for every valid exec oracle). Counterexample without the
  zero-width guard: `unguarded_zero_width_spins` (spins for any fuel). Mutation M4
  (guard removed) broke `loop_terminates`.
- `truncateToScanLimit`: `detectSensitive` carried its own copy of the cut; it now calls
  `truncateToScanLimit`, so the tested function is the one used. New test cuts through
  2-, 3- and 4-byte characters: no throw, well-formed text, round-trips through UTF-8.
  Note: a split character becomes U+FFFD (3 bytes), so the result can be up to 2 bytes
  over the limit. The rule claims valid text, not a byte cap, so this is not a defect.
- `maskFinding`: reviewed every `SECRET_PATTERNS` entry; all have a `FINDING_PREFIX`,
  so the 4-character fallback is never reached. The existing tests back it; no Lean.

## Lead 3: npx fallback `@latest` (mcp-config.ts `#version`): CONFIRMED+FIXED

The comment said "never @latest" but the code fell back to `'latest'` when
`CLI_VERSION` was not release-shaped. Test first:
`packages/cli/test/formal-secrets-install-npx-pin.test.ts` mocks `CLI_VERSION` to
`''`, `dev`, `1.2`, `1.2.3; rm -rf ~` and `latest`. Before the fix it failed with
`{"command":"/bin/sh","args":["-lc","exec npx -y @plur-ai/mcp@latest"]}`. Fix: a
version that is not release-shaped now throws (neither pinned nor replaced by @latest).
The test passes. It is reachable only from a broken build: version-parity.test.ts
already pins `CLI_VERSION` to the release shape.

## Lead 4: comment accuracy: FIXED (comment only)

- config-file.ts header: now says that a failed protection (or the opt-out) logs a
  line and the write stands.
- actor-keys.ts header: key path is `<store>/keys` (or `PLUR_KEYS_DIR`). "Never synced"
  is kept because sync's `.gitignore` lists `keys/`.
- embedding-gemma.ts: `isLoaded` reports in-process load; `modelPresent` checks the disk.
- dsh memory-section.ts `renderBlock`: constraints go last, replaced by a WITHHELD notice;
  when not even the notice fits, the notice alone is emitted past the budget (owner decision below).

## Other unbacked rules: TESTED

- `actor-keys.ts#tmp`: `formal-secrets-install-keywrite.test.ts` makes the key write
  fail part way and makes the rename fail. Neither leaves a key file or a temp file, and
  the next init writes a whole key. Mutation (write straight to the key file): all 3 failed.
- `embedding-gemma.ts#(module)` and `#isLoaded`: `formal-secrets-install-gemma.test.ts`
  (stubbed transformers). Mutations: reading `last_hidden_state` failed the test, and so
  did `isLoaded` checking the disk.
- `mcp-config.ts#mergePlurMcp` and `#agyConfigDir`: `formal-secrets-install-merge.test.ts`.
  The init-twice test reads the built CLI. Replayed by hand with the current dist in a temp
  home (cwd inside it): the mcp_config.json sha256 was the same after both runs
  (`f6c21b83…`), and only `.gemini/config/{mcp_config,hooks}.json` existed.

## Possible gap — DECIDED (owner, option "notice")

dsh `renderBlock`: when the budget is below the WITHHELD notice (~60 tokens), the whole
block is empty, so constraints are dropped with no notice. Options: (a) accept, because
an empty block is "no memory", not "no rules"; (b) always emit the notice even past budget;
(c) set a minimum budget in the caller.

Applied (b): with constraints present and no rung fitting, `renderBlock` returns the notice
alone, past the budget; with no constraints, a block that does not fit is still empty, and a
zero budget still renders nothing (the config requires at least 1). Test, red before
(`expected '' to contain '## CONSTRAINTS'`), green after:
`packages/dsh/test/memory-section.test.ts::shows the withheld notice alone when not even the
notice fits the budget` (budgets 1 and 5). It replaces the pin "emits nothing when not even the
notice fits", which asserted the old behaviour; "emits nothing when a tiny budget holds no
constraints to withhold" keeps the empty case. No Lean model covers `renderBlock`.
