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
    try:
        return {_norm(x) for x in json.loads(Path(baseline).read_text()).get("green", [])}
    except (OSError, ValueError, AttributeError, TypeError):
        return set()


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
    args = ap.parse_args(argv)
    run = _sibling("run")
    cfg = _sibling("config").load(args.config, root=args.root)
    held = green(cfg.baseline)
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
