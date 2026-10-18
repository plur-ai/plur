# Promise evals

`evals/promises.yaml` says what PLUR promises, one plain sentence each. The files
under `evals/<capability>/` are the proof. They are not part of `pnpm test`.

```bash
pnpm evals                     # scoreboard: every promise green, red or no-eval
pnpm evals:gate                # fails when a promise that was green goes red,
                               #     or the baseline is missing or unreadable
pnpm evals:gate --base origin/main   # also: no promise green on main may leave the baseline unretired
pnpm evals --exclude-kind agent      # nightly: the paid agent evals listed as not-run
python3 scripts/test_evals_harness.py   # the harness's own tests (some run real vitest: pnpm install first)
pnpm evals:bite                # every planted bug must turn its promise red
pnpm exec vitest run --config evals/vitest.config.ts evals/recall   # one folder
node evals/helpers/provision-model.mjs fetch    # put the embedding model in $PLUR_MODEL_CACHE_DIR
node evals/helpers/provision-model.mjs verify   # ...and prove it loads with downloads off
```

The `pnpm` scripts are shortcuts for people. CI calls `python3 .evals/gate.py`,
`run.py` and `bite.py` directly, because a pull request can rewrite `package.json`.

The scripts in `.evals/` are vendored from the Datacore dev module and are
language-agnostic. Python 3.11 with PyYAML runs them.

The evals never download anything (see the network rule below), so the quality
evals need the real embedding model in the cache before they run. CI fetches and
verifies it in its own step; locally, run the two `provision-model.mjs` commands
above once with `PLUR_MODEL_CACHE_DIR` set.

## How a promise becomes green

1. **The promise comes first.** It is one sentence in the owner's words about
   what a user observes, grouped by capability. Incidents are evidence, not
   promises.
2. **The eval is written from the promise.** Its file is
   `evals/<capability>/test_promise_<ID>_<what>.test.ts`, for example
   `test_promise_REC4_forgotten_never_returns.test.ts`.
3. **The eval is shown to bite.** `evals/mutants/<ID>-<n>.patch` is a planted
   bug: a minimal source change that breaks the promise. `bite.py` checks the
   promise is green without the patch and red with it.
   - A mutant that survives is a defect in the eval.
   - A promise whose `today` is `broken` has a red eval instead. That red output
     is the evidence, and its mutants come once it is fixed.
   - Evals that drive the MCP server load `@plur-ai/core` from its **built**
     dist, so a bug planted in core source does nothing there until
     `pnpm -r build`, which `bite.py` does not run; plant those bugs in
     `packages/mcp/src`. Real-agent evals run the built server entirely. Planted
     bugs that need a rebuild live in `evals/mutants/manual/` and are checked by
     hand.
4. **The baseline records it.** `evals/baseline.json` lists the green promises.
   From then on CI fails if one of them goes red. `--write-baseline` refuses to
   drop a promise that was green unless it is retired (or `--allow-drop`, which
   needs review); a missing or unreadable baseline fails the gate, and
   `--write-baseline` refuses to overwrite an unreadable one (restore it from
   git; only a missing file starts a new baseline).

### First baseline (bootstrap)

`gate.py --base <ref>` compares against the baseline on the target branch. The
pull request that brings the evals to a branch that has never had them has no
such baseline: the gate says plainly that the base has no evals config and
exits 1. That is never read as "nothing to gate".

For that one pull request, run the gate with `--bootstrap`. It then gates only
against the pull request's own baseline and prints that it did so; nothing on
the base can be checked for dropped promises, so the owner reviews the baseline
by hand. In CI the owner sets the repository variable `EVALS_BOOTSTRAP=true`
(pull requests cannot set it) and removes it once the evals are merged. When the
base has an evals config, `--bootstrap` is ignored and the base is gated as usual,
so a variable left on cannot weaken the gate.

## Rules for every eval (each prevents a mistake that has been made before)

| Rule | The mistake it prevents |
|---|---|
| Expected values are **literals taken from the promise**. Never import a constant from the code under test to compute what to expect. | `feedback.test.ts` took its expected value from `POSITIVE_STRENGTH_DELTA`, so any change to that constant passed. |
| Every "at most", "never more than" or "not included" check also asserts that a **precondition holds**: the result is non-empty, and the thing excluded was really there to exclude. | A "≤ 3 results" test passed on zero results. |
| Assert **behaviour**, not shape. `toBeDefined`, `typeof`, "is a function" and snapshot-only checks are not evals. | Tool-registration tests proved a tool existed, not that it worked. |
| Drive the **public surface** (`new Plur`, `learn`, `recall*`, `inject*`, the MCP server, the CLI). Import package **source**, never `dist`, so a planted bug takes effect without a rebuild. | Tests of a private helper passed while the public path skipped it. |
| Use the **embedder the promise needs**. Keyword-only or the bag-of-words stub is for deterministic promises; the real model is for quality promises only. A meaning eval must also be failed by a keyword-only **control arm**. | Every recall test could pass with embeddings off. |
| A quality eval reads **frozen labels** from `evals/gold/` and compares against a **literal floor** the owner set. Labels are written from the promise by someone who has not read the code, and they are versioned, never edited in place. | A score tuned against its own test set; labels written by the implementer. |
| **Failure messages say in plain words** what was expected and what was seen. | Triage that cannot tell why a promise is red. |
| No eval reads or writes the real `~/.plur` (`helpers/setup.ts` moves `HOME`) or reaches the network. Team-store evals use the in-process stub server. `setup.ts` makes `fetch` to anything but this machine fail, but only inside the vitest process: a child process an eval spawns (the CLI, hooks, git) and other transports (`node:http`, sockets) are not covered by it, so an eval that spawns one must point it at a local stub itself. | Evals that pass on one machine only. |
| **Skipped means red.** Never use `it.skip` or `skipIf` to get past a missing dependency; the eval must fail and say what was missing. | A suite that silently skipped whenever nothing was built. |

## Who may change what

- **Implementers never edit evals.** An existing eval, mutant or gold set is
  changed only with the approval of a code owner (`.github/CODEOWNERS`). If an
  eval looks wrong, report it. Do not weaken it.
- **A change to an eval goes in its own pull request**, never in the same one as
  the code it judges.
- **A promise that changes meaning gets a new id.** The old id is listed under
  `retired:` in `evals/promises.yaml` with what replaced it and why, and its eval
  file is moved to the new id. Only a retired id may leave the baseline.
  Every retired entry needs `id`, `reason` and `replaced_by` naming a promise
  that is still active; the id must no longer be active. Otherwise the gate and
  the scoreboard stop with "could not tell" and exit 1.
- **The judge is everything that decides a verdict**: all of `evals/`, `.evals/`,
  the harness tests, the evals workflow, CODEOWNERS, the root `package.json` and
  shared test fixtures under `packages/*/test/helpers/`
  (`scripts/check-eval-separation.py`).

## Kinds

| Kind | When | Where it runs |
|---|---|---|
| deterministic | the code decides it | every pull request (the gate) |
| quality | "the right memory" on labelled data | dev set: every pull request; private holdout: nightly |
| formal | "never / always" over all states | `spec/formal`, every pull request |
| agent | what a real agent does with PLUR attached; it must pass all three runs (fewer runs never certify) | weekly, and by hand before each release (RELEASING.md, pre-release step 5); costs money |
