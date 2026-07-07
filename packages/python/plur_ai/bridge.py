"""Thin bridge to the PLUR CLI binary.

Resolves the `plur` command, runs a subcommand with ``--json``, and parses the
result. Cross-runtime JSON-over-subprocess is the standard Datacore pattern
(the same one ``plur-hermes`` uses); this is a slimmer, framework-agnostic copy.

Resolution order:
  1. an explicit ``binary`` passed to :class:`plur_ai.Plur`
  2. the ``PLUR_CLI`` env var (a full command, shell-split — handy for tests/CI,
     e.g. ``PLUR_CLI="node /path/to/packages/cli/dist/index.js"``)
  3. a ``plur`` binary on ``PATH``
  4. an ``npx @plur-ai/cli`` fallback if Node is installed
"""
from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
from typing import Any, Sequence

# @plur-ai/cli pin for the npx fallback. Keep >= the published CLI that carries
# the current scope-routing / leak-guard fixes; release tooling bumps this.
_NPX_CLI_VERSION = "0.10.1"
_DEFAULT_TIMEOUT = 30


class PlurError(RuntimeError):
    """A PLUR CLI invocation failed."""


class PlurNotInstalledError(PlurError):
    """Neither a `plur` binary nor Node/npx could be found."""


def _resolve_base_command(explicit_bin: str | None = None) -> list[str]:
    if explicit_bin:
        return [explicit_bin]
    env_cli = os.environ.get("PLUR_CLI")
    if env_cli:
        return shlex.split(env_cli)
    found = shutil.which("plur")
    if found:
        return [found]
    npx = shutil.which("npx")
    if npx:
        return [npx, "-y", f"@plur-ai/cli@{_NPX_CLI_VERSION}"]
    raise PlurNotInstalledError(
        "PLUR CLI not found. Install Node, then `npm install -g @plur-ai/cli`, "
        "or set PLUR_CLI to a full command."
    )


def run_json(
    args: Sequence[str],
    *,
    binary: str | None = None,
    path: str | None = None,
    timeout: float = _DEFAULT_TIMEOUT,
) -> Any:
    """Run ``plur <args> --json`` and return the parsed JSON (dict/list/None)."""
    cmd = _resolve_base_command(binary) + list(args) + ["--json"]
    env = dict(os.environ)
    if path:
        env["PLUR_PATH"] = path
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, env=env
        )
    except FileNotFoundError as exc:  # binary vanished between resolve and run
        raise PlurNotInstalledError(str(exc)) from exc
    except subprocess.TimeoutExpired as exc:
        raise PlurError(
            f"PLUR CLI timed out after {timeout}s: plur {' '.join(args)}"
        ) from exc

    if proc.returncode != 0:
        raise PlurError(
            proc.stderr.strip() or f"PLUR CLI exited with code {proc.returncode}"
        )

    out = proc.stdout.strip()
    if not out:
        return None
    # The CLI may emit log lines before the JSON payload; take the last JSON line.
    for line in reversed(out.splitlines()):
        line = line.strip()
        if line.startswith(("{", "[")):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
    raise PlurError(f"Could not parse JSON from CLI output: {out[:200]}")
