#!/usr/bin/env python3
"""Which tests this checkout can run: the ones whose needs it has.

Some tests check an INSTALLATION rather than the code (a registry, a module
repo that is not this one, a CLI, other machines, a real agent session). A bare
checkout -- a CI runner -- has none of those. The needs file declares what such
a test needs; each need is CHECKED, never assumed. Where it is met, the test is
collected as before; where it is missing, the test is left out and the run says
what it left out and why. The scoreboard (its scoreboard env set) collects
everything: there a missing need is a red.

Needs file:
    tests:
      - {test: tests/test_x.py, needs: [cli:plur], why: runs the PLUR CLI}
      - {test: tests/test_y.py, only: [test_one], needs: [role:system/2-projects/app]}

Need vocabulary:
    module:<name>       <modules_dir>/<name> exists (default .datacore/modules)
    file:<path>         relative to the repo root, or ~/... for this user's home
    role:<role>/<path>  that path inside the space the install gives the role
    cli:<name>          the command is on PATH
    python:<module>     the package is importable
    fleet               the fleet roster exists (default .datacore/registry/infrastructure.yaml)
    agent               real agent sessions are allowed (DATACORE_AGENT_EVALS=1 by default)

    needs.py --config evals.yaml    # prints what this machine leaves out
"""
from __future__ import annotations

import argparse
import importlib.util
import os
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path

KINDS = ("module", "file", "role", "cli", "python", "fleet", "agent")


def _sibling(name: str):
    key = f"evals_{name}"
    if key not in sys.modules:
        spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(f"{name}.py"))
        sys.modules[key] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sys.modules[key])
    return sys.modules[key]


@dataclass
class Context:
    root: Path
    env: dict = field(default_factory=lambda: dict(os.environ))
    agent_env: str = "DATACORE_AGENT_EVALS"
    modules_dir: str = ".datacore/modules"
    fleet_file: str = ".datacore/registry/infrastructure.yaml"
    scoreboard_env: dict = field(default_factory=lambda: {"PROMISE_EVALS_ALL": "1"})


def load(path: Path | None) -> list[dict]:
    if not path or not Path(path).exists():
        return []
    import yaml
    return list((yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}).get("tests") or [])


def met(need: str, ctx: Context) -> bool:
    k, _, arg = str(need).partition(":")
    if k == "module":
        return (ctx.root / ctx.modules_dir / arg).is_dir()
    if k == "file":
        return (Path(arg).expanduser() if arg.startswith("~") else ctx.root / arg).exists()
    if k == "role":
        role, _, sub = arg.partition("/")
        space = _sibling("config").role_space(role, ctx.root)
        return bool(space) and (ctx.root / space / sub).exists()
    if k == "cli":
        return shutil.which(arg) is not None
    if k == "python":
        try:
            return importlib.util.find_spec(arg) is not None
        except (ImportError, ValueError):
            return False
    if k == "fleet":
        return (ctx.root / ctx.fleet_file).exists()
    if k == "agent":
        return ctx.env.get(ctx.agent_env) == "1"
    raise ValueError(f"unknown need {need!r}; one of {', '.join(KINDS)}")


def keys(entry: dict) -> list[str]:
    only = entry.get("only") or []
    return [f"{entry['test']}::{n}" for n in only] if only else [str(entry["test"])]


def matches(nodeid: str, declared: str) -> bool:
    if "::" not in declared:
        return nodeid == declared or nodeid.startswith(declared + "::")
    return nodeid == declared or nodeid.startswith(declared + "[") or nodeid.startswith(declared + "::")


def unmet_by_test(entries: list[dict], ctx: Context) -> dict[str, list[str]]:
    """{'<file>[::<test>]': [unmet needs]}; empty on a scoreboard run."""
    if any(ctx.env.get(k) == v for k, v in ctx.scoreboard_env.items()):
        return {}
    out: dict[str, list[str]] = {}
    for e in entries:
        missing = [n for n in e.get("needs") or [] if not met(n, ctx)]
        for key in keys(e) if missing else []:
            out[key] = missing
    return out


def context_for(cfg) -> Context:
    return Context(root=cfg.root, agent_env=next(iter(cfg.agent_env), "DATACORE_AGENT_EVALS"),
                   scoreboard_env=cfg.scoreboard_env)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default="evals.yaml")
    ap.add_argument("--root", default=None)
    args = ap.parse_args(argv)
    cfg = _sibling("config").load(args.config, root=args.root)
    entries = load(cfg.needs)
    why = {k: e.get("why", "") for e in entries for k in keys(e)}
    left = unmet_by_test(entries, context_for(cfg))
    if not left:
        print(f"this machine runs every declared test ({len(entries)} declared)")
    for key, missing in left.items():
        print(f"left out {key}: needs {', '.join(missing)}" + (f" -- {why[key]}" if why.get(key) else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
