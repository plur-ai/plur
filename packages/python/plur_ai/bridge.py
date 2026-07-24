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
import signal
import subprocess
from typing import Any, Sequence

# @plur-ai/cli pin for the npx fallback. Keep >= the published CLI that carries
# the current scope-routing / leak-guard fixes.
#
# release.sh bumps this to the release version alongside the hermes pin, and
# packages/hermes/scripts/check_version_sync.py enforces pin >= published
# @plur-ai/cli. A stale pin silently runs a pre-release CLI on the npx-fallback
# write path, bypassing that release's scope-routing / leak-guard fixes.
_NPX_CLI_VERSION = "0.15.0"
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


def _parse_json_tail(out: str) -> Any:
    """Return the last JSON object/array line in ``out``, or ``None`` if none.

    The CLI may emit log lines before the JSON payload; take the last JSON line.
    """
    for line in reversed(out.splitlines()):
        line = line.strip()
        if line.startswith(("{", "[")):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
    return None


def _kill_process_group(proc: "subprocess.Popen[str]") -> None:
    """SIGTERM (then SIGKILL) the child's *entire* process group.

    The child is started with ``start_new_session=True`` so it leads its own
    process group; any grandchild it spawns (e.g. the ``node`` CLI under an
    ``npx`` parent) inherits that group. Killing the group — not just the direct
    child — is what stops the grandchild from orphaning to PID 1 and spinning.

    POSIX only; on other platforms fall back to killing the direct child.
    """
    if os.name != "posix":
        proc.kill()
        return
    try:
        pgid = os.getpgid(proc.pid)
    except ProcessLookupError:
        return
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        proc.wait(timeout=0.5)  # brief grace for SIGTERM before escalating
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def _run_in_process_group(
    cmd: list[str], *, env: dict[str, str], timeout: float
) -> "subprocess.CompletedProcess[str]":
    """``subprocess.run``-equivalent with process-group teardown on timeout.

    ``subprocess.run(cmd, timeout=...)`` SIGKILLs only the *direct* child, so a
    grandchild (the ``node`` CLI spawned by an ``npx`` parent) is orphaned to
    PID 1 and keeps running — the leak this guards against. Here the child leads
    its own session/process group and, on timeout, we kill the whole group, then
    re-raise ``subprocess.TimeoutExpired`` so callers behave exactly as they did
    under ``subprocess.run``.
    """
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
        start_new_session=True,
    )
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill_process_group(proc)
        # Drain pipes / reap the direct child so we don't leak fds or a zombie.
        try:
            stdout, stderr = proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout, stderr = proc.communicate()
        raise subprocess.TimeoutExpired(cmd, timeout, output=stdout, stderr=stderr)
    return subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)


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
        proc = _run_in_process_group(cmd, env=env, timeout=timeout)
    except FileNotFoundError as exc:  # binary vanished between resolve and run
        raise PlurNotInstalledError(str(exc)) from exc
    except subprocess.TimeoutExpired as exc:
        raise PlurError(
            f"PLUR CLI timed out after {timeout}s: plur {' '.join(args)}"
        ) from exc

    # Exit 2 is the CLI's "empty result set" signal — a recall/search with no
    # matches emits {"results": [], "count": 0} and exits 2 (recall.ts). That is
    # a normal no-match, NOT an error; the plur-hermes bridge treats it the same
    # way (plur_hermes/bridge.py). Return the empty payload so recall() yields []
    # instead of raising. Any OTHER nonzero code is a real failure. (#495)
    if proc.returncode == 2:
        parsed = _parse_json_tail(proc.stdout.strip())
        return parsed if parsed is not None else {"results": [], "count": 0}

    if proc.returncode != 0:
        raise PlurError(
            proc.stderr.strip() or f"PLUR CLI exited with code {proc.returncode}"
        )

    out = proc.stdout.strip()
    if not out:
        return None
    parsed = _parse_json_tail(out)
    if parsed is not None:
        return parsed
    raise PlurError(f"Could not parse JSON from CLI output: {out[:200]}")
