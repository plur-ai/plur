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


def _docs(cfg) -> list[dict]:
    files: list[Path] = []
    for g in cfg.promise_globs:
        files += sorted(Path(p) for p in __import__("glob").glob(str(cfg.root / g)))
    docs = [yaml.safe_load(f.read_text(encoding="utf-8")) or {} for f in files]
    return [d for d in docs if isinstance(d, dict)]


def kinds(cfg) -> dict[str, str]:
    """{id: kind} (deterministic, quality, agent, ...); a promise without one is deterministic."""
    out: dict[str, str] = {}
    for doc in _docs(cfg):
        for grp in [doc] + list(doc.get("capabilities") or []):
            for p in grp.get("promises") or []:
                if isinstance(p, dict) and "id" in p:
                    out[str(p["id"])] = str(p.get("kind") or "deterministic")
    return out


def retired(cfg) -> dict[str, dict]:
    """{normalized id: entry} for promises retired on purpose (`retired:` in a promises file).

    A promise whose meaning changes gets a new id and its old id is listed here, so the
    gate and the baseline can tell a deliberate retirement from a promise that vanished."""
    out: dict[str, dict] = {}
    for doc in _docs(cfg):
        for r in doc.get("retired") or []:
            if isinstance(r, dict) and "id" in r:
                out[norm(r["id"])] = r
    return out


def retirement_problems(cfg) -> list[str]:
    """What is wrong with the `retired:` entries; empty when every one is valid.

    A retirement takes a promise out of the gate, so it must be a deliberate, complete
    change (second audit R-05): an id, a reason, and `replaced_by` naming a promise that
    is still active -- or, for a promise that moved with its code to another repository's
    gate, `moved_to` naming that repository (owner/repo) instead. An id that is both active and retired, or a replacement that is
    itself retired or unknown, would let a stale entry stop gating a promised behaviour."""
    active = {norm(p) for p in promises(cfg)}
    problems: list[str] = []
    seen: set[str] = set()
    for doc in _docs(cfg):
        for r in doc.get("retired") or []:
            if not isinstance(r, dict) or not str(r.get("id") or "").strip():
                problems.append(f"a retired entry has no id: {r!r}")
                continue
            rid = str(r["id"])
            if norm(rid) in seen:
                problems.append(f"retired {rid} is listed twice")
            seen.add(norm(rid))
            if norm(rid) in active:
                problems.append(f"retired {rid} is still an active promise")
            if not str(r.get("reason") or "").strip():
                problems.append(f"retired {rid} has no reason")
            repl = str(r.get("replaced_by") or "").strip()
            moved = r.get("moved_to")
            if moved is not None:
                # The promise and its eval moved, with the code they cover, to another
                # repository's gate: it names that repository and has no replacement here.
                if repl:
                    problems.append(f"retired {rid} is both moved_to and replaced_by; it is one or the other")
                elif not re.fullmatch(r"[\w.-]+/[\w.-]+", str(moved).strip()):
                    problems.append(f"retired {rid} is moved_to {moved!r}, which is not an owner/repository")
            elif not repl:
                problems.append(f"retired {rid} names no replacement (replaced_by) and no repository it moved to (moved_to)")
            elif norm(repl) not in active:
                problems.append(f"retired {rid} is replaced_by {repl}, which is not an active promise")
    return problems


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


def _error_type(child) -> str:
    """The error class behind a junit failure: vitest writes it in `type`; pytest's report
    names an assertion only in its message or text."""
    if child.get("type"):
        return str(child.get("type")).rsplit(".", 1)[-1]
    text = f"{child.get('message') or ''}\n{child.text or ''}"
    if re.match(r"\s*assert\b", child.get("message") or "") or re.search(r"^E\s+AssertionError\b", text, re.M):
        return "AssertionError"
    return "unknown"


def _note(name, child) -> str:
    """One failure line: `<case>: failure (<ErrorType>): <message>`. The error type is how
    bite.py tells an assertion that caught a planted bug from a crash (second audit R-04)."""
    if child.tag == "skipped":
        return f"{name}: skipped: {(child.get('message') or '')[:900]}"
    msg = " ".join(filter(None, [child.get("message"), (child.text or "").strip()[-600:]]))
    return f"{name}: {child.tag} ({_error_type(child)}): {msg[:900]}"


def run_chunk(cwd: Path, files: list[Path], env: dict, timeout_s: int) -> dict[str, tuple[bool, str]]:
    """{file name: (all its tests passed, what failed)} for one pytest run."""
    result = {f.name: (False, "could not tell: pytest never reported this file") for f in files}
    if not cwd.is_dir():
        return {f.name: (False, f"could not tell: suite directory {cwd} is not there") for f in files}
    with tempfile.NamedTemporaryFile(suffix=".xml", delete=False) as fh:
        xml = fh.name
    try:
        proc = subprocess.run([PY, "-m", "pytest", "-q", "-p", "no:cacheprovider", "--continue-on-collection-errors",
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
                notes.append(_note(case.get("name"), child))
        seen[fname] = (ok, notes)
    for fname, (ok, notes) in seen.items():
        result[fname] = (ok, "\n".join(notes))
    return _process_failure(proc.returncode, proc.stdout + proc.stderr, result)


# What a test process prints when something failed outside every test case. vitest
# reports an unhandled error or rejection with an "Unhandled ..." banner, and a global
# teardown that throws as "error during close" -- after the report was written, and with
# exit 0 when every case passed (second audit R-06).
LIFECYCLE = re.compile(r"unhandled (?:error|rejection)|error during close", re.I)


def _process_failure(code: int, output: str, result: dict[str, tuple[bool, str]]) -> dict[str, tuple[bool, str]]:
    """A run that failed outside its test cases cannot prove a promise, whatever its report says.

    vitest exits 1 on an unhandled rejection that happened outside every test case, while
    its JUnit report lists each case as passed; reading only the report turned such a run
    green (audit E-01). A global teardown that throws is worse: exit 0 and a passing report
    (R-06). An error vitest attributes to a file ("This error originated in <file>") reds
    that file; one nobody can attribute, or a failed exit with no failing case at all, reds
    every file in the chunk -- also when another file failed an assertion, because that
    failure does not account for the process error. Failures the report already attributes
    keep their attribution."""
    lifecycle = LIFECYCLE.search(output)
    if code == 0 and lifecycle is None:
        return result
    attributed = any(not ok for ok, _ in result.values())
    if attributed and lifecycle is None:
        return result      # the failed exit is explained by the failing cases
    tail = output.strip()[-600:]
    named = {n for n in result if re.search(r"originated in \"?[^\n\"]*" + re.escape(n), output)}
    victims = named or set(result)
    seen = f"; it printed: {output[lifecycle.start():][:300].strip()}" if lifecycle else ""
    why = (f"the test process exited {code} with an error outside any test case "
           f"(unhandled error, teardown or startup failure){'' if named else '; it could not be attributed to one file'}"
           f"{seen}: {tail}")
    return {n: ((False, (d + "\n" if d and not ok else "") + why) if n in victims else (ok, d))
            for n, (ok, d) in result.items()}


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
                    notes.append(_note(case.get("name"), child))
            seen[fname] = (ok, notes)
    for fname, (ok, notes) in seen.items():
        result[fname] = (ok, "\n".join(notes))
    return _process_failure(proc.returncode, (proc.stdout or "") + (proc.stderr or ""), result)


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


def score(cfg, only=None, agents: bool = False, runner=None, files=None, exclude_kinds=()) -> Board:
    """`exclude_kinds` promises are listed as `not-run` (never green, never counted red):
    the nightly job leaves out the paid agent evals it does not run (audit E-05)."""
    ps = promises(cfg)
    files = eval_files(cfg) if files is None else files
    only = {norm(x) for x in (only or ())}
    wanted = {pid: t for pid, t in ps.items() if not only or norm(pid) in only}
    skipped = {pid for pid, k in kinds(cfg).items() if k in set(exclude_kinds) and pid in wanted}
    env_base = dict(cfg.scoreboard_env)
    timeout = cfg.timeout_s
    if agents:
        env_base.update(cfg.agent_env)
        timeout = max(timeout, cfg.agent_timeout_s)

    by_suite: dict[str, list[Path]] = defaultdict(list)
    for pid in wanted:
        if pid in skipped:
            continue
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
        if pid in skipped:
            board.status[pid] = "not-run"
            board.details[pid] = f"not run here: kind {kinds(cfg)[pid]} is excluded from this run"
            continue
        if not fs:
            board.status[pid] = "no-eval"
            continue
        res = [results.get(f"{s}:{f.name}", (False, f"could not tell: suite {s} did not run")) for s, f in fs]
        board.status[pid] = "green" if all(ok for ok, _ in res) else "red"
        board.details[pid] = "\n".join(f"{f.name}: {d}" for (ok, d), (_, f) in zip(res, fs) if not ok)
    return board


def write_baseline(cfg, board: Board, only: set[str], allow_drop: bool = False) -> list[str]:
    """Record green promises; with --only, keep earlier greens. Returns the regressions.

    A promise green in the old baseline that is not green now is a regression, and the
    baseline is NOT rewritten (a full rewrite used to drop it silently, audit E-03) --
    unless it was retired on purpose (`retired:`) or `allow_drop` is given.

    Raises ValueError, writing nothing, when the retirements are invalid or an earlier
    baseline exists but cannot be read: a corrupt baseline is lost history, not an empty
    one (second audit R-05). With no baseline file at all it is created."""
    gate = _sibling("gate")
    problems = retirement_problems(cfg)
    if problems:
        raise ValueError("invalid retirements: " + "; ".join(problems))
    greens = {norm(p) for p, st in board.status.items() if st == "green"}
    if cfg.baseline is None:
        raise ValueError("the config names no baseline file")
    prev = gate.read_baseline(cfg.baseline) if Path(cfg.baseline).exists() else set()
    gone = retired(cfg)
    lost = sorted(prev - greens - set(gone)) if not only else []
    if lost and not allow_drop:
        return lost
    prev -= set(gone)
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
    ap.add_argument("--allow-drop", action="store_true",
                    help="with --write-baseline: drop promises that were green and are not now (needs review)")
    ap.add_argument("--exclude-kind", default="", help="kinds to list as not-run instead of running, e.g. agent")
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

    problems = retirement_problems(cfg)
    if problems:
        print("could not tell: the retired promises are invalid, so what is promised is unknown:")
        for p in problems:
            print(f"  {p}")
        return 1
    if args.write_baseline and cfg.baseline is not None and Path(cfg.baseline).exists():
        try:
            _sibling("gate").read_baseline(cfg.baseline)     # refuse before spending a full run
        except ValueError as e:
            print(f"could not tell: {e}. The baseline is NOT rewritten: an unreadable baseline is lost "
                  f"history, not an empty one. Restore it from git (or delete it on purpose to start over).")
            return 1
    board = score(cfg, only=only, agents=args.agents,
                  exclude_kinds=[k.strip() for k in args.exclude_kind.split(",") if k.strip()])
    regressed = []
    if args.write_baseline:
        try:
            regressed = write_baseline(cfg, board, only, allow_drop=args.allow_drop)
        except ValueError as e:
            print(f"could not tell: {e}. The baseline is NOT written.")
            return 1
        if regressed:
            print(f"REGRESSED since the last baseline: {', '.join(regressed)}"
                  + ("" if args.allow_drop else " -- baseline NOT written (retire them, or --allow-drop)"))
    counts = board.counts()
    if args.json:
        print(json.dumps({"counts": counts, "promises": board.status, "details": board.details,
                          "files": board.files}, indent=1))
    else:
        for pid, st in board.status.items():
            print(f"{st:10} {pid:10} {board.text[pid][:90]}")
        print("\n" + "  ".join(f"{k}: {v}" for k, v in sorted(counts.items())))
    if regressed and not args.allow_drop:
        return 1
    return 0 if counts.get("red", 0) == 0 and counts.get("no-eval", 0) == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
