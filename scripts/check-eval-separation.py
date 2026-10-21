#!/usr/bin/env python3
"""Fail a pull request that changes an eval and the code it judges together.

Everything that decides a verdict is the judge: all of evals/** (promises, evals,
helpers, config, gold, mutants, baseline), .evals/**, this checker and its test, the
harness tests, the evals workflow and CODEOWNERS, the root package.json (its scripts
run before the gate), and fixtures under packages/*/test/helpers/ that evals
import (the team stub server). Source under packages/*/src is the defendant. A change to both in one pull request is how a
judge gets loosened on the day it would have gone red -- Datacore's first evals
were weakened exactly that way. Eval changes go in their own pull request,
approved by a code owner.

Usage: check-eval-separation.py <base-ref> [--strict]   (reads `git diff --name-only --no-renames -z <base>...HEAD`)
Exit 1 when both kinds changed; prints the files.

--strict is for the overnight agent's stacked pull requests (fourth audit A4-01): the
change may hold ONLY product source and product tests (packages/*/src,
packages/*/test outside test/helpers). A manifest, the lockfile, a build or vitest
config, a workflow, a script, a shared helper, an eval or docs are refused, alone or
not: their code runs before or around the judge, so a product author could change
the evidence through them without touching an eval.
"""
from __future__ import annotations

import re
import subprocess
import sys

# A helper, the vitest config or evals.yaml (which names the baseline) can loosen a
# verdict as surely as an eval can; leaving them out let a pull request point the
# baseline at a missing file alongside the code change (audit E-03).
# The root package.json is the judge too: its `evals*` scripts were how CI reached the
# gate, so a pull request could turn the gate into a no-op beside a source change
# (second audit R-02). CI now calls .evals/gate.py directly, and the manifest stays here
# because its install/build scripts still run before the gate.
JUDGE = re.compile(r"^(?:package\.json|evals/.+|\.evals/.+|scripts/(?:check-eval-separation|test_check_eval_separation"
                   r"|test_evals_harness)\.py|scripts/(?:evals-local|judge-intact)\.sh|\.github/workflows/evals\.yml|\.github/CODEOWNERS"
                   r"|packages/[^/]+/test/helpers/.+)$")
CODE = re.compile(r"^packages/[^/]+/src/.+")
# What a stacked pull request may change, and nothing else.
STRICT_ALLOWED = re.compile(r"^packages/[^/]+/(?:src/.+|test/(?!helpers/).+)$")


def classify(paths: list[str]) -> tuple[list[str], list[str]]:
    return [p for p in paths if JUDGE.match(p)], [p for p in paths if CODE.match(p)]


def strict_refused(paths: list[str]) -> list[str]:
    return [p for p in paths if not STRICT_ALLOWED.match(p)]


def parse_args(argv: list[str]) -> tuple[str, bool] | None:
    rest = argv[1:]
    strict = "--strict" in rest
    rest = [a for a in rest if a != "--strict"]
    return (rest[0], strict) if len(rest) == 1 else None


def main(argv: list[str]) -> int:
    parsed = parse_args(argv)
    if parsed is None:
        print(__doc__, file=sys.stderr)
        return 2
    base, strict = parsed
    # --no-renames: a moved file is listed under both its old and new path. With
    # rename detection, moving an eval out of evals/ shows only the new path, so
    # the check would pass while the runner silently drops that eval.
    # -z: paths are NUL-separated and never quoted. Without it git quotes a path
    # with non-ASCII characters, quotes or control characters, and the quoted
    # form matches neither the judge nor the source patterns.
    out = subprocess.run(["git", "diff", "--name-only", "--no-renames", "-z", f"{base}...HEAD"],
                         capture_output=True, text=True)
    if out.returncode != 0:
        print(f"could not tell: git diff failed: {out.stderr.strip()}", file=sys.stderr)
        return 1
    paths = [p for p in out.stdout.split("\0") if p.strip()]
    if strict:
        refused = strict_refused(paths)
        if refused:
            print("A stacked pull request may change only product source and product tests "
                  "(packages/*/src, packages/*/test outside test/helpers). Refused:")
            print("  " + ", ".join(refused[:20]))
            return 1
    judge, code = classify(paths)
    if judge and code:
        print("This pull request changes evals AND the source they judge. Split it: eval changes go in their "
              "own pull request, approved by a code owner (evals/README.md).")
        print("  evals:  " + ", ".join(judge[:10]))
        print("  source: " + ", ".join(code[:10]))
        return 1
    print(f"ok: {len(judge)} eval file(s), {len(code)} source file(s) changed -- not both" + (" (strict)" if strict else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
