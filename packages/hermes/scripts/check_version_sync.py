#!/usr/bin/env python3
"""Verify version strings are in sync across plur-hermes source files.

Source of truth: pyproject.toml [project].version

Checks:
  - plur_hermes/skills/plur-memory.SKILL.md  (YAML frontmatter `version:`)
  - plur_hermes/__init__.py                  (importlib.metadata-derived; smoke check)

NPX CLI pin (`_NPX_CLI_VERSION` in bridge.py) is intentionally separate — it
tracks the @plur-ai/cli release the bridge is qualified against, not the
plur-hermes package version. We only verify it is set to a valid SemVer string.

Exits non-zero on any mismatch.
"""
from __future__ import annotations

import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _read_pyproject_version() -> str:
    data = tomllib.loads((ROOT / "pyproject.toml").read_text())
    return data["project"]["version"]


def _read_skill_version() -> str:
    text = (ROOT / "plur_hermes" / "skills" / "plur-memory.SKILL.md").read_text()
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("version:"):
            return s.split(":", 1)[1].strip()
    raise RuntimeError("SKILL.md missing `version:` in frontmatter")


def _read_npx_pin() -> str:
    text = (ROOT / "plur_hermes" / "bridge.py").read_text()
    m = re.search(r'_NPX_CLI_VERSION\s*=\s*"([^"]+)"', text)
    if not m:
        raise RuntimeError("bridge.py missing _NPX_CLI_VERSION")
    return m.group(1)


SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")


def main() -> int:
    canonical = _read_pyproject_version()
    skill = _read_skill_version()
    npx_pin = _read_npx_pin()

    errors: list[str] = []
    if skill != canonical:
        errors.append(f"SKILL.md version {skill!r} != pyproject {canonical!r}")
    if not SEMVER.match(npx_pin):
        errors.append(f"_NPX_CLI_VERSION {npx_pin!r} is not valid SemVer")

    if errors:
        print("Version sync check FAILED:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    print(f"OK: plur-hermes={canonical}, SKILL={skill}, NPX_CLI pin={npx_pin}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
