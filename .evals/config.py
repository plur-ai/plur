"""evals.yaml: where a repo's promises and evals live, so one runner scores any repo.

    root: .                         # relative to this file; --root / EVALS_ROOT override
    promises: [promises/*.yaml]     # globs; `promises:` list or `capabilities[].promises`
    id_file_pattern: '^test_promise_([A-Za-z]+)_?(\\d+)(?:_([0-9]+))?_'   # groups 1+2 = id
    suites:                         # where eval files live; each runs from its own cwd
      - {name: main, cwd: ., tests: tests, env: {}}
      - {glob: 'mods/*/tests', name: 'module:{parent}'}   # one suite per match; {name} = the matched folder
      - {name: ts, cwd: ., tests: evals, runner: vitest, recursive: true,          # TypeScript evals
         command: [pnpm, exec, vitest, run, --config, evals/vitest.config.ts, '--outputFile={junit}']}
    baseline: evals-baseline.json   # green promises the CI gate holds
    mutants: evals/mutants          # optional: planted bugs, <ID>-<n>.patch, for bite.py
    needs: test-needs.yaml          # optional: what install-local tests need
    triage_overrides: triage.overrides.yaml   # optional: id -> {bucket, note}
    chunk_files: 20                 # files per pytest run
    timeout_s: 900                  # per chunk
    scoreboard_env: {PROMISE_EVALS_ALL: '1'}          # set on every scoreboard run
    agents: {env: {DATACORE_AGENT_EVALS: '1'}, timeout_s: 5400}   # --agents

Paths may use `{root}` and `{role:<name>}`: the space an install gives a role
(install.yaml `roles:`), so a shipped config never names a space's folder.
"""
from __future__ import annotations

import glob as _glob
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

import yaml

DEFAULT_PATTERN = r"^test_promise_([A-Za-z]+)_?(\d+)(?:_([0-9]+))?_"
# Which files a suite holds, by runner. A vitest suite's command gets `{junit}`
# (the report path) filled in and the eval files appended, relative to its cwd.
RUNNER_FILES = {"pytest": "test_promise_*.py", "vitest": "test_promise_*.test.ts"}
VITEST_COMMAND = ["npx", "vitest", "run", "--reporter=junit", "--outputFile={junit}"]


@dataclass
class Suite:
    name: str
    cwd: Path
    tests: str = "tests"
    env: dict = field(default_factory=dict)
    runner: str = "pytest"
    recursive: bool = False
    command: list[str] = field(default_factory=list)

    @property
    def files_glob(self) -> str:
        return RUNNER_FILES.get(self.runner, RUNNER_FILES["pytest"])


@dataclass
class Config:
    path: Path
    root: Path
    promise_globs: list[str]
    suites: list[Suite]
    id_pattern: str = DEFAULT_PATTERN
    baseline: Path | None = None
    needs: Path | None = None
    overrides: Path | None = None
    mutants: Path | None = None
    chunk_files: int = 20
    timeout_s: int = 900
    scoreboard_env: dict = field(default_factory=lambda: {"PROMISE_EVALS_ALL": "1"})
    agent_env: dict = field(default_factory=lambda: {"DATACORE_AGENT_EVALS": "1"})
    agent_timeout_s: int = 5400


def role_space(role: str, root: Path) -> str | None:
    """The space folder (relative to root) the install gives `role`, or None.

    Uses Datacore's own resolver when the install has one; otherwise reads
    install.yaml `roles:` and finds the folder named `<value>` or `<n>-<value>`."""
    core = root / ".datacore" / "lib" / "spaces.py"
    if core.exists():
        sys.path.insert(0, str(core.parent))
        try:
            import spaces   # noqa: PLC0415
            return spaces.space_for(role, root=root)
        except Exception:   # noqa: BLE001 - fall back to reading install.yaml
            pass
        finally:
            sys.path.remove(str(core.parent))
    try:
        value = ((yaml.safe_load((root / "install.yaml").read_text()) or {}).get("roles") or {}).get(role)
    except (OSError, yaml.YAMLError, AttributeError):
        return None
    value = value[0] if isinstance(value, list) and value else value
    if not isinstance(value, str) or not value or "/" in value or ".." in value:
        return None
    if (root / value).is_dir():
        return value
    hits = sorted(p.name for p in root.glob(f"*-{value}") if p.is_dir())
    return hits[0] if hits else None


def expand(text: str, root: Path) -> str | None:
    """Fill {root} and {role:x}; None when a role is not declared here."""
    out = str(text).replace("{root}", str(root))
    while "{role:" in out:
        start = out.index("{role:")
        end = out.index("}", start)
        space = role_space(out[start + 6:end], root)
        if space is None:
            return None
        out = out[:start] + space + out[end + 1:]
    return out


def _path(value, root: Path) -> Path | None:
    if not value:
        return None
    s = expand(value, root)
    if s is None:
        return None
    p = Path(s).expanduser()
    return p if p.is_absolute() else root / p


def _runner(s: dict) -> dict:
    runner = str(s.get("runner") or "pytest")
    if runner not in RUNNER_FILES:
        raise ValueError(f"suite {s.get('name')!r}: unknown runner {runner!r} (known: {', '.join(RUNNER_FILES)})")
    command = [str(c) for c in (s.get("command") or (VITEST_COMMAND if runner == "vitest" else []))]
    return {"runner": runner, "recursive": bool(s.get("recursive", False)), "command": command}


def load(path: Path | str, root: Path | str | None = None) -> Config:
    path = Path(path).resolve()
    doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if root is None:
        root = os.environ.get("EVALS_ROOT") or doc.get("root") or "."
    root = Path(root).expanduser()
    root = (root if root.is_absolute() else path.parent / root).resolve()

    suites: list[Suite] = []
    for s in doc.get("suites") or [{"name": "main", "cwd": ".", "tests": "tests"}]:
        env_raw = s.get("env") or {}
        if s.get("glob"):
            pattern = expand(s["glob"], root)
            if pattern is None:
                continue
            for hit in sorted(_glob.glob(str(root / pattern))):
                d = Path(hit)
                name = str(s.get("name") or "{parent}").format(parent=d.parent.name, name=d.name)
                env = {k: expand(v, root) or "" for k, v in env_raw.items()}
                suites.append(Suite(name, d.parent, d.name, env, **_runner(s)))
            continue
        cwd = _path(s.get("cwd", "."), root)
        if cwd is None:   # its role is not declared on this install: the suite does not exist here
            continue
        suites.append(Suite(str(s["name"]), cwd, str(s.get("tests", "tests")),
                            {k: expand(v, root) or "" for k, v in env_raw.items()}, **_runner(s)))

    globs = []
    for g in doc.get("promises") or []:
        e = expand(g, root)
        if e is not None:
            globs.append(e)
    agents = doc.get("agents") or {}
    return Config(
        path=path, root=root, promise_globs=globs, suites=suites,
        id_pattern=str(doc.get("id_file_pattern") or DEFAULT_PATTERN),
        baseline=_path(doc.get("baseline", "evals-baseline.json"), root),
        needs=_path(doc.get("needs"), root),
        overrides=_path(doc.get("triage_overrides"), root),
        mutants=_path(doc.get("mutants"), root),
        chunk_files=int(doc.get("chunk_files", 20)),
        timeout_s=int(doc.get("timeout_s", 900)),
        scoreboard_env={str(k): str(v) for k, v in (doc.get("scoreboard_env") or {"PROMISE_EVALS_ALL": "1"}).items()},
        agent_env={str(k): str(v) for k, v in (agents.get("env") or {"DATACORE_AGENT_EVALS": "1"}).items()},
        agent_timeout_s=int(agents.get("timeout_s", 5400)),
    )
