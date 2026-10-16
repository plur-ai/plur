#!/usr/bin/env python3
"""Score every promise: green, red, or no eval -- for any repo, from its evals.yaml.

A promise is green only when it has at least one eval and every eval behind it
passes. Eval files are named `test_promise_<ID>_<what>.py` (the id with or
without its dash), or `test_promise_<ID>_<what>.test.ts` in a vitest suite. Rules:

  * no eval is `no-eval`, never a pass;
  * a skipped test is red, and so is anything the run could not tell
    (a file pytest never reported, a suite directory that is not there);
  * files run in chunks, each with its own time limit: a hang reds its own
    chunk, not the scoreboard.

Usage:
    run.py --config evals.yaml [--json] [--only ID,ID] [--list] [--agents] [--write-baseline] [--root DIR]
Exit 0 only when every promise with an eval is green AND none lacks one.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import yaml

PY = sys.executable


def _sibling(name: str):
    key = f"evals_{name}"
    if key not in sys.modules:
        spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(f"{name}.py"))
        sys.modules[key] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sys.modules[key])
    return sys.modules[key]


config = _sibling("config")


def norm(pid: str) -> str:
    """TSK-9, TSK_9, TSK9 -> TSK9; MEM-01 -> MEM1 (leading zeros never matter)."""
    m = re.match(r"^([A-Z]+)[^A-Z0-9]*0*(\d+)", str(pid).upper())
    return m.group(1) + m.group(2) if m else re.sub(r"[^A-Z0-9]", "", str(pid).upper())


def promises(cfg) -> dict[str, str]:
    """{id: promise text}, in file order. Reads `promises:` or `capabilities[].promises`."""
    out: dict[str, str] = {}
    files: list[Path] = []
    for g in cfg.promise_globs:
        files += sorted(Path(p) for p in __import__("glob").glob(str(cfg.root / g)))
    for f in files:
        doc = yaml.safe_load(f.read_text(encoding="utf-8")) or {}
        groups = [doc] + list(doc.get("capabilities") or []) if isinstance(doc, dict) else []
        for grp in groups:
            for p in grp.get("promises") or []:
                if isinstance(p, dict) and "id" in p:
                    out[str(p["id"])] = str(p.get("promise", ""))
    return out


def eval_files(cfg) -> dict[str, list[tuple[str, Path]]]:
    """{normalized id: [(suite name, file)]}"""
    pat = re.compile(cfg.id_pattern)
    found: dict[str, list[tuple[str, Path]]] = defaultdict(list)
    for s in cfg.suites:
        base = s.cwd / s.tests
        for f in sorted(base.rglob(s.files_glob) if s.recursive else base.glob(s.files_glob)):
            m = pat.match(f.name)
            if m:
                found[norm(m.group(1) + m.group(2))].append((s.name, f))
    return found


def _file_of(case, names: set[str]) -> str | None:
    """Which eval file a junit testcase belongs to (plain, class-based or a collection error)."""
    if case.get("file"):
        return Path(case.get("file")).name
    for attr in ("classname", "name"):
        for part in reversed((case.get(attr) or "").replace("/", ".").split(".")):
            if f"{part}.py" in names:
                return f"{part}.py"
    return None


def run_chunk(cwd: Path, files: list[Path], env: dict, timeout_s: int) -> dict[str, tuple[bool, str]]:
    """{file name: (all its tests passed, what failed)} for one pytest run."""
    result = {f.name: (False, "could not tell: pytest never reported this file") for f in files}
    if not cwd.is_dir():
        return {f.name: (False, f"could not tell: suite directory {cwd} is not there") for f in files}
    with tempfile.NamedTemporaryFile(suffix=".xml", delete=False) as fh:
        xml = fh.name
    try:
        subprocess.run([PY, "-m", "pytest", "-q", "-p", "no:cacheprovider", "--continue-on-collection-errors",
                        f"--junitxml={xml}", *[str(f) for f in files]],
                       cwd=cwd, env={**os.environ, **env}, capture_output=True, text=True, timeout=timeout_s)
    except subprocess.TimeoutExpired:
        print(f"TIMEOUT after {timeout_s}s in {cwd}: every file in this chunk counts red", file=sys.stderr)
        return {f.name: (False, f"timeout after {timeout_s}s (the chunk hung; this file may not be the cause)")
                for f in files}
    try:
        tree = ET.parse(xml)
    except (ET.ParseError, OSError):
        return result
    finally:
        Path(xml).unlink(missing_ok=True)
    names = {f.name for f in files}
    seen: dict[str, tuple[bool, list[str]]] = {}
    for case in tree.iter("testcase"):
        fname = _file_of(case, names)
        if fname is None:
            continue
        ok, notes = seen.get(fname, (True, []))
        for child in case:
            if child.tag in ("failure", "error", "skipped"):
                ok = False
                what = "skipped" if child.tag == "skipped" else child.tag
                msg = " ".join(filter(None, [child.get("message"), (child.text or "").strip()[-600:]]))
                notes.append(f"{case.get('name')}: {what}: {msg[:900]}")
        seen[fname] = (ok, notes)
    for fname, (ok, notes) in seen.items():
        result[fname] = (ok, "\n".join(notes))
    return result


def run_vitest_chunk(cwd: Path, files: list[Path], env: dict, timeout_s: int,
                     command: list[str] | None = None) -> dict[str, tuple[bool, str]]:
    """{file name: (all its tests passed, what failed)} for one vitest run.

    vitest's JUnit report names each file in its testsuite `name` (relative to
    cwd); a file it never reported stays "could not tell"."""
    cfg_mod = _sibling("config")
    result = {f.name: (False, "could not tell: vitest never reported this file") for f in files}
    if not cwd.is_dir():
        return {f.name: (False, f"could not tell: suite directory {cwd} is not there") for f in files}
    with tempfile.NamedTemporaryFile(suffix=".xml", delete=False) as fh:
        xml = fh.name
    Path(xml).unlink()
    cmd = [c.replace("{junit}", xml) for c in (command or cfg_mod.VITEST_COMMAND)]
    rel = [str(f.relative_to(cwd)) if f.is_relative_to(cwd) else str(f) for f in files]
    try:
        proc = subprocess.run([*cmd, *rel], cwd=cwd, env={**os.environ, **env},
                              capture_output=True, text=True, timeout=timeout_s)
    except subprocess.TimeoutExpired:
        print(f"TIMEOUT after {timeout_s}s in {cwd}: every file in this chunk counts red", file=sys.stderr)
        return {f.name: (False, f"timeout after {timeout_s}s (the chunk hung; this file may not be the cause)")
                for f in files}
    except OSError as e:
        return {f.name: (False, f"could not tell: the vitest command did not start ({e})") for f in files}
    try:
        tree = ET.parse(xml)
    except (ET.ParseError, OSError):
        tail = (proc.stderr or proc.stdout or "").strip()[-600:]
        return {f.name: (False, f"could not tell: no vitest report ({tail})") for f in files}
    finally:
        Path(xml).unlink(missing_ok=True)
    names = {f.name for f in files}
    seen: dict[str, tuple[bool, list[str]]] = {}
    for suite in tree.iter("testsuite"):
        for case in suite.iter("testcase"):
            fname = next((Path(v).name for v in (case.get("file"), case.get("classname"), suite.get("name"))
                          if v and Path(v).name in names), None)
            if fname is None:
                continue
            ok, notes = seen.get(fname, (True, []))
            for child in case:
                if child.tag in ("failure", "error", "skipped"):
                    ok = False
                    what = "skipped" if child.tag == "skipped" else child.tag
                    msg = " ".join(filter(None, [child.get("message"), (child.text or "").strip()[-600:]]))
                    notes.append(f"{case.get('name')}: {what}: {msg[:900]}")
            seen[fname] = (ok, notes)
    for fname, (ok, notes) in seen.items():
        result[fname] = (ok, "\n".join(notes))
    return result


def suite_runner(suite):
    """The chunk runner for a suite: pytest, or vitest with the suite's command."""
    if suite.runner == "vitest":
        return lambda cwd, files, env, timeout_s: run_vitest_chunk(cwd, files, env, timeout_s, suite.command)
    return run_chunk


def run_chunked(cwd: Path, files: list[Path], env: dict, chunk_files: int, timeout_s: int,
                runner=run_chunk) -> dict[str, tuple[bool, str]]:
    out: dict[str, tuple[bool, str]] = {}
    for i in range(0, len(files), max(1, chunk_files)):
        out.update(runner(cwd, files[i:i + chunk_files], env, timeout_s))
    return out


@dataclass
class Board:
    status: dict[str, str]
    text: dict[str, str]
    details: dict[str, str] = field(default_factory=dict)
    files: dict[str, list[str]] = field(default_factory=dict)

    def counts(self) -> dict[str, int]:
        c: dict[str, int] = defaultdict(int)
        for v in self.status.values():
            c[v] += 1
        return dict(c)


def score(cfg, only=None, agents: bool = False, runner=None, files=None) -> Board:
    ps = promises(cfg)
    files = eval_files(cfg) if files is None else files
    only = {norm(x) for x in (only or ())}
    wanted = {pid: t for pid, t in ps.items() if not only or norm(pid) in only}
    env_base = dict(cfg.scoreboard_env)
    timeout = cfg.timeout_s
    if agents:
        env_base.update(cfg.agent_env)
        timeout = max(timeout, cfg.agent_timeout_s)

    by_suite: dict[str, list[Path]] = defaultdict(list)
    for pid in wanted:
        for suite, f in files.get(norm(pid), []):
            by_suite[suite].append(f)
    results: dict[str, tuple[bool, str]] = {}
    for s in cfg.suites:
        if by_suite.get(s.name):
            for fname, res in run_chunked(s.cwd, sorted(set(by_suite[s.name])), {**env_base, **s.env},
                                          cfg.chunk_files, timeout, runner or suite_runner(s)).items():
                results[f"{s.name}:{fname}"] = res
    board = Board(status={}, text=wanted)
    for pid in wanted:
        fs = files.get(norm(pid), [])
        board.files[pid] = [f"{s}:{f}" for s, f in fs]
        if not fs:
            board.status[pid] = "no-eval"
            continue
        res = [results.get(f"{s}:{f.name}", (False, f"could not tell: suite {s} did not run")) for s, f in fs]
        board.status[pid] = "green" if all(ok for ok, _ in res) else "red"
        board.details[pid] = "\n".join(f"{f.name}: {d}" for (ok, d), (_, f) in zip(res, fs) if not ok)
    return board


def write_baseline(cfg, board: Board, only: set[str]) -> list[str]:
    """Record green promises; with --only, keep earlier greens. Returns the regressions."""
    gate = _sibling("gate")
    greens = {norm(p) for p, st in board.status.items() if st == "green"}
    prev = gate.green(cfg.baseline)
    lost = sorted(prev - greens) if not only else []
    cfg.baseline.parent.mkdir(parents=True, exist_ok=True)
    cfg.baseline.write_text(json.dumps({"green": sorted(greens | (prev if only else set()))}, indent=1) + "\n")
    return lost


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default="evals.yaml")
    ap.add_argument("--root", default=None, help="the repo root (overrides the config's root:)")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--only", default="")
    ap.add_argument("--list", action="store_true", help="list promises and eval files, run nothing")
    ap.add_argument("--agents", action="store_true", help="also run agent-behaviour evals (real model runs)")
    ap.add_argument("--write-baseline", action="store_true", help="record the green promises (the CI gate)")
    args = ap.parse_args(argv)
    cfg = config.load(args.config, root=args.root)
    only = {norm(x) for x in args.only.split(",") if x.strip()}

    if args.list:
        files = eval_files(cfg)
        ps = {p: t for p, t in promises(cfg).items() if not only or norm(p) in only}
        status = {p: f"{len(files.get(norm(p), []))} eval file(s)" for p in ps}
        listing = {p: [f"{s}:{f.relative_to(next(x.cwd for x in cfg.suites if x.name == s))}"
                       for s, f in files.get(norm(p), [])] for p in ps}
        counts: dict[str, int] = defaultdict(int)
        for v in status.values():
            counts[v.split()[0]] += 1
        if args.json:
            print(json.dumps({"counts": counts, "promises": status, "files": listing}, indent=1))
        else:
            for p, st in status.items():
                print(f"{st:10} {p:10} {ps[p][:90]}")
            print("\n" + "  ".join(f"{k}: {v}" for k, v in sorted(counts.items())))
        return 1

    board = score(cfg, only=only, agents=args.agents)
    if args.write_baseline:
        lost = write_baseline(cfg, board, only)
        if lost:
            print(f"REGRESSED since the last baseline: {', '.join(lost)}")
    counts = board.counts()
    if args.json:
        print(json.dumps({"counts": counts, "promises": board.status, "details": board.details,
                          "files": board.files}, indent=1))
    else:
        for pid, st in board.status.items():
            print(f"{st:10} {pid:10} {board.text[pid][:90]}")
        print("\n" + "  ".join(f"{k}: {v}" for k, v in sorted(counts.items())))
    return 0 if counts.get("red", 0) == 0 and counts.get("no-eval", 0) == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
