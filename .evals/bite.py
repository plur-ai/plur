#!/usr/bin/env python3
"""Does every eval bite? Plant each recorded bug and check its promise goes red.

"An eval that has never failed has not been shown to work." Writing that as a
sentence in an evidence field let evals through that were never seen red. Here
it is a check: each planted bug is a patch in the config's `mutants:` folder,
named `<ID>-<n>.patch` (REC-1-1.patch is the first planted bug for REC-1). For
each one:

  1. the promise must be green WITHOUT the patch -- a "kill" on code that was
     already red proves nothing. Such a mutant is `waiting`: the promise is
     proven by its own red output today, and its planted bugs are checked once
     it is fixed. Waiting does not fail the run;
  2. the patch is applied to the working tree, the promise's evals are run,
     and the patch is reversed whatever happens;
  3. red with the patch = killed. Green with the patch = survived: the eval
     does not catch the bug it was written for, and that is a defect in the
     eval, for the owner. A patch that does not apply is could-not-tell.

Run it on a clean checkout (CI, or a scratch worktree): it refuses when tracked
files have uncommitted changes, because it edits them in place.

Usage:
    bite.py --config evals.yaml [--only ID,ID] [--json]
Exit 0 when every mutant is killed or waiting; 1 when one survived or could not
be told; 2 when it refused to run.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


def _sibling(name: str):
    key = f"evals_{name}"
    if key not in sys.modules:
        spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(f"{name}.py"))
        sys.modules[key] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sys.modules[key])
    return sys.modules[key]


MUTANT = re.compile(r"^([A-Za-z]+)[-_]?0*(\d+)[-_](\d+)(?:[-_][\w.-]*)?\.patch$")


@dataclass
class Result:
    mutant: str
    promise: str
    verdict: str          # killed | survived | could-not-tell | waiting
    note: str = ""


def _git(root: Path, *args: str, check: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, check=check)


def toplevel(path: Path) -> Path:
    out = _git(path, "rev-parse", "--show-toplevel")
    if out.returncode != 0:
        raise RuntimeError(f"{path} is not inside a git repository")
    return Path(out.stdout.strip())


def mutants(cfg) -> dict[str, list[Path]]:
    """{normalized promise id: [patch files]}"""
    out: dict[str, list[Path]] = {}
    if not cfg.mutants or not Path(cfg.mutants).is_dir():
        return out
    for p in sorted(Path(cfg.mutants).glob("*.patch")):
        m = MUTANT.match(p.name)
        if m:
            out.setdefault(m.group(1).upper() + m.group(2), []).append(p)
    return out


def dirty(root: Path) -> list[str]:
    out = _git(root, "status", "--porcelain", "--untracked-files=no")
    return [line[3:] for line in out.stdout.splitlines() if line.strip()]


def check(cfg, only=None, runner=None) -> list[Result]:
    run = _sibling("run")
    only = {run.norm(x) for x in (only or ())}
    by_norm = {run.norm(p): p for p in run.promises(cfg)}
    root = toplevel(cfg.root)
    results: list[Result] = []
    for pid, patches in mutants(cfg).items():
        if only and pid not in only:
            continue
        name = by_norm.get(pid, pid)
        before = run.score(cfg, only={pid}, runner=runner).status.get(name, "no-eval")
        if before != "green":
            results += [Result(p.name, name, "waiting",
                               f"the promise is not green without the mutant ({before})") for p in patches]
            continue
        for patch in patches:
            applies = _git(root, "apply", "--check", str(patch))
            if applies.returncode != 0:
                results.append(Result(patch.name, name, "could-not-tell",
                                      f"the patch does not apply: {applies.stderr.strip()[:300]}"))
                continue
            _git(root, "apply", str(patch), check=True)
            try:
                board = run.score(cfg, only={pid}, runner=runner)
            finally:
                undo = _git(root, "apply", "-R", str(patch))
                if undo.returncode != 0:
                    raise RuntimeError(f"could not reverse {patch.name}: {undo.stderr.strip()} -- "
                                       f"restore the working tree by hand (git diff shows the mutant)")
            after = board.status.get(name, "no-eval")
            if after == "red":
                results.append(Result(patch.name, name, "killed", (board.details.get(name) or "")[:300]))
            else:
                results.append(Result(patch.name, name, "survived",
                                      f"the promise stayed {after} with the bug planted"))
    return results


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default="evals.yaml")
    ap.add_argument("--root", default=None)
    ap.add_argument("--only", default="")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    cfg = _sibling("config").load(args.config, root=args.root)
    run = _sibling("run")
    try:
        root = toplevel(cfg.root)
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        return 2
    changed = dirty(root)
    if changed:
        print("refusing: tracked files have uncommitted changes, and bite.py edits files in place: "
              + ", ".join(changed[:10]), file=sys.stderr)
        return 2
    only = {run.norm(x) for x in args.only.split(",") if x.strip()}
    results = check(cfg, only=only)
    planted = set(mutants(cfg))
    no_mutant = [p for p in run.promises(cfg) if run.norm(p) not in planted and (not only or run.norm(p) in only)]
    if args.json:
        print(json.dumps({"mutants": {r.mutant: r.verdict for r in results},
                          "notes": {r.mutant: r.note for r in results if r.verdict != "killed"},
                          "no_mutant": no_mutant}, indent=1))
    else:
        for r in results:
            print(f"{r.verdict:15} {r.mutant:30} {r.promise:8} {r.note[:120] if r.verdict != 'killed' else ''}")
        counts: dict[str, int] = {}
        for r in results:
            counts[r.verdict] = counts.get(r.verdict, 0) + 1
        print("\n" + "  ".join(f"{k}: {v}" for k, v in sorted(counts.items()))
              + f"  promises with no planted bug: {len(no_mutant)}")
    return 0 if all(r.verdict in ("killed", "waiting") for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
