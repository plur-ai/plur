# Planted bugs checked by hand

`bite.py` reads only `evals/mutants/*.patch`. The patches here are kept out of
that folder for one of three reasons:

- the eval runs the built server (`packages/mcp/dist`), so the patch only takes
  effect after a rebuild that `bite.py` does not do; or
- the patch was checked and **survived**, and the owner has to decide how the
  eval changes; or
- it was written for a promise that is red today, and moves to `evals/mutants/`
  once the promise is green.

To check one: apply it, `pnpm --filter @plur-ai/mcp build`, run the eval, then
reverse the patch and rebuild.

| Patch | Promise | Result | Open question |
|---|---|---|---|
| BEH-2-1 | a correction sticks in the next session (BEH-2) | **survived** (2026-10-15, 1 run) | The correction text ends "Remember that.", and the server's "never Y → save it" rule also fits, so removing the correction instructions changes nothing. Either drop "Remember that." from the scenario, or plant a bug on the save path instead. |
| BEH-2-2 | a correction (BEH-2) or a fact I asked it to remember (BEH-3) is saved and used next session | not yet run with real agents (written 2026-10-17). Checked without an agent: with the patch, `plur_learn` over MCP answers with an id and the statement, and the reopened store does not hold it; the grader unit test rejects exactly that transcript (`agent-behaviour-graders.unit.test.ts`, "acknowledge without persisting") | Expected: BEH-2 and BEH-3 turn red in session 1 ("…the server said it succeeded, but no memory … is in the store when it is reopened"). Confirm in the paid run. |
| BEH-2-1 (re-check) | BEH-2 | the survival above was with "Remember that." in the scenario; that sentence is now gone (audit B-02) | Re-run with the paid agent evals: without it, removing the correction instructions should now matter. |
| TEAM-5-1 | no network calls when offline (TEAM-5) | turns the engine tests red (2026-10-15) | Waits here because the promise is red today (the npm update check). Move it to evals/mutants/ once TEAM-5 is green. |
