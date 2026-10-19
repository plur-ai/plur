# Writing promises and evals that are worth having

The rules below were settled over a week of making 214 promises green on a real
system. Each names the mistake it prevents. `/evals`, the eval-writer agent and
`init` all follow them.

## Promises

1. **One plain sentence the owner would say, in their voice.** "A deferred task
   wakes up on its date by itself." Not "the wake sweep advances SCHEDULED
   properties". If the owner has to ask what it means, rewrite it. *Prevents:*
   a catalogue the owner cannot review ("these are hard for me to understand").
2. **Say what the owner observes, never how the code does it.** Internal names,
   ids and file paths belong in the evidence, not the promise.
3. **Group promises by capability and cover the whole behaviour, not the
   incidents.** Start from what each capability is for (`what_it_does`), then
   list what must always be true of it. A past incident is *evidence* for a
   promise, not a promise. *Prevents:* evals that only address specific issues
   and miss overall behaviour, so regressions elsewhere go unseen.
4. **Record today's state honestly:** `today: holds | broken | unknown`, with
   the `evidence` that says so. `unknown` is allowed and common; guessing is
   not.
5. **Cover every kind of important property**, not a test count: behaviour,
   invariants, failure modes (what happens when a dependency is down), security
   and privacy boundaries, data safety, and compatibility. Coverage percentage
   is not the goal.
6. **Keep ids stable once used.** A promise that changes meaning gets a new id;
   the old one is retired, not rewritten.

## Evals

7. **Every eval must bite.** It is committed red before the fix, and it must be
   seen failing against a broken or planted-broken version. A test that cannot
   fail is worse than none. Record the planted bug as a patch
   (`<mutants>/<ID>-<n>.patch`) so `bite.py` re-checks it on every run, instead
   of a sentence in an evidence field nobody re-runs. *Prevents:* two tests that passed for weeks while
   testing nothing, because the call they used had been reclassified.
8. **The grader judges the promise, not a stand-in for it.** If the promise is
   "never switches to a paid key", merely reading the key file is not
   switching. A proxy that is easier to check is a different promise.
9. **Choose the kind by what can prove the promise:**

   | Kind | Use when | Rule |
   |---|---|---|
   | Deterministic | the code decides it | fixtures and fakes; never the live install |
   | Formal (Lean, via `/formal-verify`) | "never", "always", "at most once" over all states | a counterexample counts only once replayed against the real code |
   | Agent behaviour | what an agent *does* in a tempting setup | pass^3: all three runs pass, not one of three; the scaffold gets the real standing context, is isolated from the real data, and has the tools it needs |
   | Production | the live system: jobs, machines, schedules, hooks | declare its needs; "could not tell" is red, never skipped |

10. **Deterministic graders first; an AI judge only for depth.** A structural
    check catches missing parts but scores generic content as perfect; a judge
    rubric is added only where judgment is the point.
11. **The failure message says, in plain words, what was expected and what was
    seen** — it is what triage and the owner will read.
12. **Test the cause, not the symptom.** An eval that passes because an alert
    was cleared by hand is testing the clean-up.
13. **Name nothing install-specific in shipped evals**: no machine, agent,
    account or folder names; resolve spaces by role and declare install-local
    needs.

## Who may change what

14. **Implementers never edit evals.** A guard asks before any change to an
    eval; the eval-writer drafts new evals red for the owner's approval and
    never touches implementation code.
15. **A revision to an eval is the owner's decision.** Stop and report an eval
    that looks wrong; do not weaken it.
16. **Owner decisions go as a few plain principles,** not rows of
    implementation options ("what may leave the machine?", not "RRF floor
    0.35 or 0.4?"). Derive the rows from the principles.
