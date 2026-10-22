#!/usr/bin/env python3
"""Pull requests into an integration/** branch skip the GitHub test runs, and
are re-checked on GitHub instead of trusted.

Owner, 2026-10-18: "For CI and evals, we should do as much local as possible.
Let's not burn GitHub usage where we don't need to", and yes to skipping CI for
the pull requests that stack onto the overnight agent's integration branch. The
integration branch itself still gets every run once, when it comes into
development. A skipped run must never read as a pass (ci.yml, the #903 note),
and a pasted gate output is no proof (fourth audit A4-02), so the
stacked-local-proof workflow re-checks each pull request on one Linux job: the
strict separation check, the judge's integrity after build, and the evals of
the promises it names.

Run: python3 scripts/test_stacked_ci_skip.py
"""
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
WF = ROOT / ".github" / "workflows"
STACKED = "integration/**"
PROOF = WF / "stacked-local-proof.yml"


def _on(path: Path) -> dict:
    d = yaml.safe_load(path.read_text())
    return d.get(True) or d.get("on") or {}   # yaml reads a bare `on:` as True


def test_every_pull_request_test_run_skips_integration_branches():
    missing = []
    for path in sorted(WF.glob("*.yml")):
        if path == PROOF:
            continue
        on = _on(path)
        if "pull_request" not in on:
            continue   # pull_request_target / review events are not test runs
        pr = on["pull_request"] or {}
        allow = pr.get("branches")
        if allow and not any(b.startswith("integration") or b.startswith("*") for b in allow):
            continue   # an allow-list without integration branches (evals.yml: development, main)
        if STACKED not in (pr.get("branches-ignore") or []):
            missing.append(path.name)
    assert not missing, f"these workflows still run on pull requests into {STACKED}: {missing}"


def test_stacked_pull_requests_are_rerun_not_trusted():
    # Fourth audit A4-02: the pasted gate output proved nothing (a body reading
    # "Not run. regressed: 0" passed). The check now re-runs, on GitHub, the evals of
    # the promises the pull request names, after the strict separation check and the
    # judge-integrity check. It runs from the BASE branch's workflow
    # (pull_request_target), and the checking scripts and the baseline come from a
    # second checkout of the base commit, never from the pull request's tree, so a
    # pull request cannot rewrite the checks meant to stop it (review of #1670).
    # Fork pull requests do not run; the token is read-only, with no secrets and no
    # shared cache.
    assert PROOF.exists(), PROOF
    on = _on(PROOF)
    assert set(on) == {"pull_request_target"}, on
    assert on["pull_request_target"]["branches"] == [STACKED], on["pull_request_target"]
    assert {"opened", "edited", "synchronize", "reopened"} <= set(on["pull_request_target"]["types"])
    d = yaml.safe_load(PROOF.read_text())
    assert d["permissions"] == {"contents": "read"}, d.get("permissions")
    text = PROOF.read_text()
    assert "secrets." not in text and "actions/cache" not in text
    assert "github.event.pull_request.head.sha" in text and "persist-credentials: false" in text
    (job,) = d["jobs"].values()
    assert job.get("if") == "github.event.pull_request.head.repo.full_name == github.repository", job.get("if")
    checkouts = [st for st in job["steps"] if str(st.get("uses", "")).startswith("actions/checkout@")]
    by_path = {st["with"]["path"]: st["with"] for st in checkouts}
    assert set(by_path) == {"judge", "pr"}, by_path
    assert by_path["judge"]["ref"] == "${{ github.event.pull_request.base.sha }}", by_path["judge"]
    assert by_path["pr"]["ref"] == "${{ github.event.pull_request.head.sha }}", by_path["pr"]
    assert all(w.get("persist-credentials") is False for w in by_path.values()), by_path
    # every checking script and the baseline are the base commit's copy
    steps_run = [st.get("run", "") for st in job["steps"]]
    sep = next(r for r in steps_run if "check-eval-separation.py" in r)
    assert "../judge/scripts/check-eval-separation.py" in sep, sep
    intact = next(r for r in steps_run if "judge-intact.sh" in r)
    assert "../judge/scripts/judge-intact.sh" in intact, intact
    baseline = next(i for i, r in enumerate(steps_run) if "baseline.json" in r)
    assert "judge/evals/baseline.json" in steps_run[baseline], steps_run[baseline]
    # the baseline is read before any code of the pull request runs
    assert baseline < next(i for i, r in enumerate(steps_run) if "pnpm install" in r)
    # the description is read from the environment, never pasted into the script
    assert "${{ github.event.pull_request.body }}" not in text.split("env:")[0]
    runs = "\n".join(st.get("run", "") for job in d["jobs"].values() for st in job["steps"])
    order = [runs.index(n) for n in ("check-eval-separation.py", "--strict", "pnpm -r build",
                                      "judge-intact.sh", ".evals/run.py")]
    assert order == sorted(order), order
    assert "--only" in runs and "Promises:" in runs
    assert "evals/baseline.json" in runs   # a claimed promise must not be one already protected
    # the old self-attested substrings are gone
    assert "regressed: 0" not in text and "evals-local: results in" not in text


if __name__ == "__main__":
    failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except AssertionError as e:
                failed += 1
                print(f"FAIL {name}\n  {e}")
    sys.exit(1 if failed else 0)
