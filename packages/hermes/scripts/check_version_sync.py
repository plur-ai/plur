#!/usr/bin/env python3
"""Verify version strings are in sync across plur-hermes source files.

Source of truth: pyproject.toml [project].version

Checks:
  - plur_hermes/skills/plur-memory.SKILL.md  (YAML frontmatter `version:`)
  - plur_hermes/bridge.py                     (`_NPX_CLI_VERSION` npx-fallback pin)

The npx pin (`_NPX_CLI_VERSION`) is the @plur-ai/cli version the bridge's
npx-fallback write path runs. A stale pin silently runs a PRE-FIX CLI that
bypasses the scope-routing / leak-guard fixes, so we no longer accept "any valid
SemVer". The pin must be:

  - a valid SemVer, AND
  - >= the local pyproject version (the release version; release.sh bumps both
    in lockstep, so during a release pin == pyproject), AND
  - >= the published @plur-ai/cli@latest version when npm is reachable
    (best-effort; a network/registry failure does NOT fail the check — the
    pyproject floor above is the deterministic, offline-enforceable guarantee).

Exits non-zero on any mismatch.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

CLI_PACKAGE = "@plur-ai/cli"


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


SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$")


def _version_tuple(v: str) -> tuple[int, int, int]:
    """Parse the numeric MAJOR.MINOR.PATCH core of a SemVer for >= comparison.

    Pre-release/build metadata is ignored for ordering — sufficient here since
    we only ever compare release versions (no pre-release pins in practice).
    """
    m = SEMVER.match(v)
    if not m:
        raise ValueError(f"not a valid SemVer: {v!r}")
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)))


def _published_cli_version() -> str | None:
    """Best-effort: the @plur-ai/cli@latest version from the npm registry.

    Returns None on any failure (no npm, offline, registry error) so the
    deterministic offline pyproject-floor check remains the hard gate.
    """
    try:
        out = subprocess.run(
            ["npm", "view", CLI_PACKAGE, "version", "--json"],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None
    if out.returncode != 0:
        return None
    raw = (out.stdout or "").strip()
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None
    # `npm view ... --json` returns a JSON string for a single match.
    if isinstance(parsed, str):
        return parsed
    if isinstance(parsed, list) and parsed:
        return str(parsed[-1])
    return None


def main() -> int:
    canonical = _read_pyproject_version()
    skill = _read_skill_version()
    npx_pin = _read_npx_pin()

    errors: list[str] = []
    if skill != canonical:
        errors.append(f"SKILL.md version {skill!r} != pyproject {canonical!r}")

    if not SEMVER.match(npx_pin):
        errors.append(f"_NPX_CLI_VERSION {npx_pin!r} is not valid SemVer")
    else:
        # Hard, offline gate: the npx pin must be >= the release (pyproject)
        # version. release.sh bumps both in lockstep, so a forgotten pin bump
        # trips here. This is what makes a stale pin impossible to ship.
        if _version_tuple(npx_pin) < _version_tuple(canonical):
            errors.append(
                f"_NPX_CLI_VERSION {npx_pin!r} < pyproject/release {canonical!r} "
                f"— the npx-fallback would run a pre-release CLI lacking this "
                f"release's fixes; bump _NPX_CLI_VERSION in bridge.py"
            )
        else:
            # Best-effort online gate: pin must also be >= the published CLI so
            # the fallback never installs an OLDER CLI than what users already
            # get from `npm install -g @plur-ai/cli`. Skipped silently offline.
            published = _published_cli_version()
            if published and SEMVER.match(published):
                if _version_tuple(npx_pin) < _version_tuple(published):
                    errors.append(
                        f"_NPX_CLI_VERSION {npx_pin!r} < published {CLI_PACKAGE} "
                        f"{published!r} — the npx-fallback would run an older CLI "
                        f"than the one published to npm; bump _NPX_CLI_VERSION"
                    )

    if errors:
        print("Version sync check FAILED:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    print(f"OK: plur-hermes={canonical}, SKILL={skill}, NPX_CLI pin={npx_pin}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
