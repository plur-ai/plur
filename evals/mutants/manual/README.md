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
| TEAM-5-1 | no network calls when offline (TEAM-5) | turns the engine tests red (2026-10-15) | Waits here because the promise is red today (the npm update check). Move it to evals/mutants/ once TEAM-5 is green. |
