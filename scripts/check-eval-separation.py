#!/usr/bin/env python3
"""Fail a pull request that changes an eval and the code it judges together.

An eval (evals/**/test_promise_*, evals/mutants/**, evals/gold/**,
evals/promises.yaml, evals/baseline.json, .evals/**) is the judge; source under
packages/*/src is the defendant. A change to both in one pull request is how a
judge gets loosened on the day it would have gone red -- Datacore's first evals
were weakened exactly that way. Eval changes go in their own pull request,
approved by a code owner.

Usage: check-eval-separation.py <base-ref>     (reads `git diff --name-only <base>...HEAD`)
Exit 1 when both kinds changed; prints the files.
"""
from __future__ import annotations

import re
import subprocess
import sys

JUDGE = re.compile(r"^(?:evals/(?:.*/)?test_promise_[^/]+|evals/mutants/.+|evals/gold/.+|evals/promises\.yaml"
                   r"|evals/baseline\.json|\.evals/.+)$")
CODE = re.compile(r"^packages/[^/]+/src/.+")


def classify(paths: list[str]) -> tuple[list[str], list[str]]:
    return [p for p in paths if JUDGE.match(p)], [p for p in paths if CODE.match(p)]


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    out = subprocess.run(["git", "diff", "--name-only", f"{argv[1]}...HEAD"], capture_output=True, text=True)
    if out.returncode != 0:
        print(f"could not tell: git diff failed: {out.stderr.strip()}", file=sys.stderr)
        return 1
    judge, code = classify([p for p in out.stdout.splitlines() if p.strip()])
    if judge and code:
        print("This pull request changes evals AND the source they judge. Split it: eval changes go in their "
              "own pull request, approved by a code owner (evals/README.md).")
        print("  evals:  " + ", ".join(judge[:10]))
        print("  source: " + ", ".join(code[:10]))
        return 1
    print(f"ok: {len(judge)} eval file(s), {len(code)} source file(s) changed -- not both")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
