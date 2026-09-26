#!/usr/bin/env python3
"""Check a repository's formal models: build, gaps, axioms, drift.

This file is VENDORED into each verified repository's Lean project (next to its
verify.yaml) by `/formal-verify`, so the repository's CI can run it without depending
on the dev module. Keep it standard-library only apart from PyYAML.

    python3 formal_check.py [--project DIR] [--base REF] [--no-build] [--strict-drift]
                            [--if-touched]

Checks, in order:
  1. build   `lake build` succeeds in the project.
  2. gaps    no `sorry`, `admit`, `native_decide` or `axiom` declaration in any
             model file. A proof with a gap is not a proof.
  3. axioms  every theorem under the configured libraries depends only on the
             allowed axioms (default: propext, Classical.choice, Quot.sound).
             Generated and run with `lake env lean`; the count is reported.
  4. drift   with --base, a source file a model covers changed since REF while
             the model did not. The proof then describes code that may no longer
             exist. A warning, or a failure with --strict-drift.

With --if-touched (needs --base), nothing runs unless the project or a covered
file changed since REF — how the local pre-push gate keeps unrelated pushes free.

Exit codes: 0 all checks pass, 1 a check failed, 2 configuration error.

verify.yaml (in the project directory):

    libraries: [CoreSpec]                      # lean_lib names = namespaces checked
    allowed_axioms: [propext, Classical.choice, Quot.sound]   # optional
    strict_drift: false                        # optional: drift fails the check
    models:
      - model: CoreSpec/Scheduler.lean         # relative to the project dir
        covers: [src/scheduler.py]             # relative to the repository root
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

DEFAULT_AXIOMS = ["propext", "Classical.choice", "Quot.sound"]
GAP = re.compile(r"\b(sorry|admit|native_decide)\b")
AXIOM_DECL = re.compile(r"^\s*axiom\s")
AUDIT_FILE = ".formal_audit.lean"

AUDIT_TEMPLATE = """import Lean
{imports}
open Lean Elab Command

elab "#formal_audit" : command => do
  let env ← getEnv
  let ok : List Lean.Name := [{allowed}]
  let prefixes : List Lean.Name := [{prefixes}]
  let mut n := 0
  let mut bad : Array (Lean.Name × Array Lean.Name) := #[]
  for (nm, ci) in env.constants.toList do
    let ours := prefixes.any (fun p => p.isPrefixOf nm)
    let isThm : Bool := match (ci : Lean.ConstantInfo) with
      | Lean.ConstantInfo.thmInfo _ => true
      | _ => false
    if ours && isThm then
      n := n + 1
      let axs : Array Lean.Name ← Lean.collectAxioms nm
      let extra : Array Lean.Name := axs.filter (fun a => !ok.contains a)
      if Array.size extra > 0 then bad := bad.push (nm, extra)
  logInfo m!"formal-audit theorems={{n}} offenders={{bad.size}} {{bad.toList}}"

#formal_audit
"""


def load_config(project: Path) -> dict:
    import yaml
    path = project / "verify.yaml"
    if not path.is_file():
        raise SystemExit(f"config error: {path} not found")
    cfg = yaml.safe_load(path.read_text()) or {}
    if not cfg.get("libraries"):
        raise SystemExit("config error: verify.yaml needs `libraries`")
    return cfg


# Variables git exports to hooks. Inherited by our own git calls they override
# `-C`: in a worktree pre-push hook GIT_DIR is set without GIT_WORK_TREE, so
# `rev-parse --show-toplevel` answered with the current directory and every
# covered file looked missing. Our git calls locate the repo from `-C` alone.
_HOOK_GIT_VARS = ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
                  "GIT_PREFIX", "GIT_OBJECT_DIRECTORY")


def _git_env() -> dict:
    import os
    return {k: v for k, v in os.environ.items() if k not in _HOOK_GIT_VARS}


def repo_root(project: Path) -> Path:
    out = subprocess.run(["git", "-C", str(project), "rev-parse", "--show-toplevel"],
                         capture_output=True, text=True, env=_git_env())
    return Path(out.stdout.strip()) if out.returncode == 0 else project


def lake() -> str:
    import shutil
    elan = Path.home() / ".elan" / "bin" / "lake"
    return str(elan) if elan.exists() else (shutil.which("lake") or "lake")


def check_build(project: Path) -> tuple[bool, str]:
    r = subprocess.run([lake(), "build"], cwd=project, capture_output=True, text=True)
    errors = [l for l in (r.stdout + r.stderr).splitlines() if l.startswith("error")]
    return r.returncode == 0, ("build ok" if r.returncode == 0 else "build FAILED: " + "; ".join(errors[:5]))


def model_files(project: Path, libraries: list[str]) -> list[Path]:
    files = []
    for lib in libraries:
        files += sorted((project / lib).rglob("*.lean"))
        root = project / f"{lib}.lean"
        if root.exists():
            files.append(root)
    return files


def strip_comments(text: str) -> str:
    """Drop Lean block and line comments so words in prose do not count."""
    text = re.sub(r"/-.*?-/", "", text, flags=re.S)
    return "\n".join(line.split("--", 1)[0] for line in text.splitlines())


def check_gaps(project: Path, libraries: list[str]) -> tuple[bool, str]:
    found = []
    for f in model_files(project, libraries):
        code = strip_comments(f.read_text())
        for i, line in enumerate(code.splitlines(), 1):
            if GAP.search(line) or AXIOM_DECL.match(line):
                found.append(f"{f.relative_to(project)}:{i}: {line.strip()[:60]}")
    return not found, ("no gaps" if not found else f"{len(found)} gap(s): " + "; ".join(found[:5]))


def check_axioms(project: Path, libraries: list[str], allowed: list[str]) -> tuple[bool, str]:
    src = AUDIT_TEMPLATE.format(
        imports="\n".join(f"import {lib}" for lib in libraries),
        allowed=", ".join(f"``{a}" for a in allowed),
        prefixes=", ".join(f"`{lib}" for lib in libraries))
    # The audit imports the libraries, so they must be built. `lake build` of
    # up-to-date libraries is a no-op; on a fresh checkout it is what makes
    # --no-build safe to use without a confusing import error.
    built = subprocess.run([lake(), "build", *libraries], cwd=project, capture_output=True, text=True)
    if built.returncode != 0:
        return False, "axiom audit needs the libraries to build; they do not"
    audit = project / AUDIT_FILE
    audit.write_text(src)
    try:
        r = subprocess.run([lake(), "env", "lean", AUDIT_FILE], cwd=project,
                           capture_output=True, text=True)
    finally:
        audit.unlink(missing_ok=True)
    m = re.search(r"formal-audit theorems=(\d+) offenders=(\d+)(.*)", r.stdout + r.stderr)
    if not m:
        return False, "axiom audit did not run: " + (r.stdout + r.stderr).strip()[-200:]
    n, bad = int(m.group(1)), int(m.group(2))
    if n == 0:
        return False, "axiom audit found no theorems (wrong libraries in verify.yaml?)"
    return bad == 0, f"{n} theorems, {bad} using axioms outside {allowed}" + (m.group(3)[:200] if bad else "")


def changed_files(root: Path, base: str) -> set[str] | None:
    r = subprocess.run(["git", "-C", str(root), "diff", "--name-only", f"{base}...HEAD"],
                       capture_output=True, text=True, env=_git_env())
    if r.returncode != 0:
        return None
    return {l.strip() for l in r.stdout.splitlines() if l.strip()}


def touched(project: Path, cfg: dict, base: str) -> bool | None:
    """Did anything verified change since `base`? None when git cannot tell."""
    root = repo_root(project)
    changed = changed_files(root, base)
    if changed is None:
        return None
    rel = str(project.resolve().relative_to(root.resolve()))
    covered = {c for e in cfg.get("models") or [] for c in e.get("covers") or []}
    return any(c == rel or c.startswith(rel + "/") or c in covered for c in changed)


def check_drift(project: Path, cfg: dict, base: str | None) -> tuple[bool, str, list[str]]:
    root = repo_root(project)
    rel_project = project.resolve().relative_to(root.resolve())
    problems, drift = [], []
    for entry in cfg.get("models") or []:
        model = entry.get("model", "")
        if not (project / model).is_file():
            problems.append(f"model missing: {model}")
        for cov in entry.get("covers") or []:
            if not (root / cov).exists():
                problems.append(f"{model} covers a missing file: {cov}")
    if problems:
        return False, "; ".join(problems[:5]), []
    if not base:
        return True, "drift not checked (no --base)", []
    changed = changed_files(root, base)
    if changed is None:
        return False, f"cannot diff against {base}", []
    for entry in cfg.get("models") or []:
        model_path = str(rel_project / entry["model"])
        touched = [c for c in entry.get("covers") or [] if c in changed]
        if touched and model_path not in changed:
            drift.append(f"{entry['model']} not updated, but {', '.join(touched)} changed")
    return True, (f"{len(drift)} model(s) may be stale" if drift else "no drift"), drift


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--project", default=str(Path(__file__).resolve().parent))
    ap.add_argument("--base", help="git ref to diff against for the drift check")
    ap.add_argument("--no-build", action="store_true")
    ap.add_argument("--strict-drift", action="store_true", help="drift fails the check")
    ap.add_argument("--if-touched", action="store_true",
                    help="with --base: skip unless the project or a covered file changed")
    args = ap.parse_args(argv)
    project = Path(args.project).resolve()
    try:
        cfg = load_config(project)
    except SystemExit as exc:
        print(exc, file=sys.stderr)
        return 2
    if args.if_touched:
        if not args.base:
            print("config error: --if-touched needs --base", file=sys.stderr)
            return 2
        hit = touched(project, cfg, args.base)
        if hit is False:
            print(f"skip    nothing verified changed since {args.base[:12]}")
            return 0
        # None (git cannot tell) runs everything: unknown is never a pass.
    libraries = cfg["libraries"]
    allowed = cfg.get("allowed_axioms") or DEFAULT_AXIOMS
    failed = False

    def report(name: str, ok: bool, detail: str) -> None:
        nonlocal failed
        failed |= not ok
        print(f"{'ok  ' if ok else 'FAIL'} {name:7} {detail}")

    if not args.no_build:
        report("build", *check_build(project))
    report("gaps", *check_gaps(project, libraries))
    report("axioms", *check_axioms(project, libraries, allowed))
    ok, detail, drift = check_drift(project, cfg, args.base)
    strict = args.strict_drift or bool(cfg.get("strict_drift"))
    if drift:
        ok = ok and not strict
        for d in drift:
            print(f"     drift   {d}")
    report("drift", ok, detail)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
