#!/usr/bin/env python3
"""The baseline gate: CI fails when a promise that was green goes red.

Evals are committed red, before the code that makes them pass, so a plain test
run must not collect them -- a red-by-design eval would break every unrelated
change. The baseline (`run.py --write-baseline`) records the green promises.
From then on:

  * an ordinary run collects a promise's evals only once it is baseline-green
    (`should_ignore`, wired from the repo's conftest.py);
  * `gate.py --config evals.yaml` runs every baseline-green promise and exits 1
    when one of them is red or has lost its eval -- a regression.

The scoreboard sets the scoreboard env (PROMISE_EVALS_ALL=1) and collects everything.

conftest.py:
    def pytest_ignore_collect(collection_path, config):
        return gate.should_ignore(collection_path, CFG) or None
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
from pathlib import Path


def _sibling(name: str):
    key = f"evals_{name}"
    if key not in sys.modules:
        spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(f"{name}.py"))
        sys.modules[key] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sys.modules[key])
    return sys.modules[key]


def _norm(x: str) -> str:
    m = re.match(r"^([A-Z]+)[^A-Z0-9]*0*(\d+)", str(x).upper())
    return m.group(1) + m.group(2) if m else re.sub(r"[^A-Z0-9]", "", str(x).upper())


def green(baseline: Path | None) -> set[str]:
    """The baseline's green ids; empty when it cannot be read (see `read_baseline`)."""
    try:
        return read_baseline(baseline)
    except ValueError:
        return set()


def read_baseline(baseline: Path | None) -> set[str]:
    """The baseline's green ids. Raises ValueError when it is missing or unreadable:
    the gate fails closed on that, it never reads a lost baseline as "nothing to gate"
    (audit E-03)."""
    if baseline is None:
        raise ValueError("the config names no baseline file")
    try:
        doc = json.loads(Path(baseline).read_text())
    except OSError as e:
        raise ValueError(f"baseline {baseline} cannot be read ({e.strerror or e})") from e
    except ValueError as e:
        raise ValueError(f"baseline {baseline} is not valid JSON ({e})") from e
    if not isinstance(doc, dict) or not isinstance(doc.get("green"), list):
        raise ValueError(f"baseline {baseline} has no `green` list")
    return {_norm(x) for x in doc["green"]}


class NoBaseConfig(ValueError):
    """The base commit exists but has no evals config: the evals are new in this change."""


def trusted_greens(cfg, base: str) -> set[str]:
    """The green ids of the baseline at `base` (the pull request's target), read from git
    with the base's own evals config -- so a pull request cannot lower the bar by editing
    the baseline or pointing the config at another file.

    Raises NoBaseConfig when `base` is a real commit without the evals config (the first
    pull request that brings the evals), ValueError for anything else it cannot read."""
    import subprocess
    import yaml
    root = cfg.root

    def git(*args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True)

    def show(path: str) -> str:
        out = git("show", f"{base}:{path}")
        if out.returncode != 0:
            raise ValueError(f"could not read {path} at {base}: {out.stderr.strip()}")
        return out.stdout

    cfg_rel = os.path.relpath(cfg.path, root)
    if git("rev-parse", "--verify", "--quiet", f"{base}^{{commit}}").returncode != 0:
        raise ValueError(f"{base} is not a commit here (is the base branch fetched?)")
    if git("cat-file", "-e", f"{base}:{cfg_rel}").returncode != 0:
        raise NoBaseConfig(f"the base {base} has no evals config ({cfg_rel})")
    base_cfg = yaml.safe_load(show(cfg_rel)) or {}
    rel = base_cfg.get("baseline")
    if not rel:
        raise ValueError(f"{cfg_rel} at {base} names no baseline")
    rel = os.path.normpath(os.path.join(os.path.dirname(cfg_rel), str(base_cfg.get("root", ".")), rel))
    doc = json.loads(show(rel))
    return {_norm(x) for x in doc.get("green", [])}


_CACHE: dict = {}


def should_ignore(path, cfg) -> bool:
    """Leave a promise eval out of an ordinary run unless it is baseline-green.
    `cfg` is a loaded Config or the path of an evals.yaml."""
    if not hasattr(cfg, "baseline"):
        key = str(cfg)
        if key not in _CACHE:
            _CACHE[key] = _sibling("config").load(cfg)
        cfg = _CACHE[key]
    m = re.match(cfg.id_pattern, Path(path).name)
    if m is None or any(os.environ.get(k) == v for k, v in cfg.scoreboard_env.items()):
        return False
    return _norm(m.group(1) + m.group(2)) not in green(cfg.baseline)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default="evals.yaml")
    ap.add_argument("--root", default=None)
    ap.add_argument("--base", default=None,
                    help="git ref of the pull request's target: its baseline is gated too, and a green "
                         "promise may leave it only by being retired")
    ap.add_argument("--bootstrap", action="store_true",
                    help="with --base: when the base has no evals config at all (the change that brings the "
                         "evals), gate only against this change's own baseline. Ignored when the base has one.")
    args = ap.parse_args(argv)
    run = _sibling("run")
    cfg = _sibling("config").load(args.config, root=args.root)
    try:
        held = read_baseline(cfg.baseline)
    except ValueError as e:
        print(f"could not tell: {e}. A lost baseline is a failure, never 'nothing to gate'.")
        return 1
    problems = run.retirement_problems(cfg)
    if problems:
        print("could not tell: the retired promises are invalid, so what the gate may drop is unknown:")
        for p in problems:
            print(f"  {p}")
        return 1
    gone = set(run.retired(cfg))
    if args.base:
        try:
            base_held = trusted_greens(cfg, args.base)
        except NoBaseConfig as e:
            if not args.bootstrap:
                print(f"could not tell: {e}, so there is no trusted baseline to compare against. If this change "
                      f"brings the evals for the first time, rerun with --bootstrap (evals/README.md, "
                      f"'First baseline'); otherwise check the base ref.")
                return 1
            print(f"BOOTSTRAP: {e}. Gating only against this change's own baseline ({len(held)} green); "
                  f"nothing on the base can be checked for drops. Review the baseline by hand.")
            base_held = set()
        except ValueError as e:
            print(f"could not tell: {e}")
            return 1
        else:
            if args.bootstrap:
                print(f"--bootstrap ignored: the base {args.base} has an evals config, so it is gated normally.")
        dropped = sorted(base_held - held - gone)
        for p in dropped:
            print(f"REGRESSED {p}: green in the baseline at {args.base}, removed here without being retired")
        if dropped:
            return 1
        held |= base_held - gone
    held -= gone
    if not held:
        print("baseline holds no green promise yet: nothing to gate")
        return 0
    board = run.score(cfg, only=held)
    ids = {run.norm(p): p for p in board.status}
    lost = sorted(p for p in held if p not in ids)       # a promise dropped from the promises files
    bad = sorted(p for p, st in board.status.items() if st != "green")
    for p in bad:
        print(f"REGRESSED {p} ({board.status[p]}): {board.text[p][:90]}")
        for line in (board.details.get(p) or "").splitlines()[:5]:
            print(f"    {line[:200]}")
    for p in lost:
        print(f"REGRESSED {p}: green in the baseline, no longer in any promises file")
    print(f"\nbaseline-green: {len(held)}  still green: {len(held) - len(bad) - len(lost)}  regressed: {len(bad) + len(lost)}")
    return 1 if bad or lost else 0


if __name__ == "__main__":
    sys.exit(main())
