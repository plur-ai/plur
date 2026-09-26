"""Formal-verification run (Adapters cluster, candidate 7, mcp-integrations#7).

A statement is DATA. The CLI's argv parser reads a leading `--x=...` token (or
an exact flag like `--json`) as a flag, and does not honour `--` for `learn`,
so a statement that looks like a flag must not travel in argv. The bridge sends
it on stdin instead, which `plur learn` reads when no positional is given.
A timed-out write must say that it timed out, not look like an empty success.
"""
import json
import os
import shutil
import subprocess
import tempfile
from unittest.mock import patch, MagicMock

import pytest

from plur_hermes.bridge import PlurBridge

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
CLI = os.path.join(REPO, "packages", "cli", "dist", "index.js")


def _ok(payload):
    m = MagicMock()
    m.returncode = 0
    m.stdout = json.dumps(payload)
    m.stderr = ""
    return m


def test_flag_like_statement_is_not_in_argv():
    bridge = PlurBridge()
    bridge._binary = "/usr/local/bin/plur"
    with patch("plur_hermes.bridge._run_in_process_group", side_effect=[_ok({"results": []}), _ok({"id": "ENG-1"})]) as run:
        bridge.learn("--path=/tmp/elsewhere is where the cache lives")
    cmd = run.call_args_list[-1][0][0]
    assert not any(a.startswith("--path=") for a in cmd), cmd
    assert run.call_args_list[-1].kwargs.get("input") == "--path=/tmp/elsewhere is where the cache lives"


def test_ordinary_statement_still_in_argv():
    bridge = PlurBridge()
    bridge._binary = "/usr/local/bin/plur"
    with patch("plur_hermes.bridge._run_in_process_group", side_effect=[_ok({"results": []}), _ok({"id": "ENG-1"})]) as run:
        bridge.learn("Use pnpm, not npm")
    assert "Use pnpm, not npm" in run.call_args_list[-1][0][0]


def test_learn_timeout_is_reported_not_silent():
    bridge = PlurBridge()
    bridge._binary = "/usr/local/bin/plur"
    with patch("plur_hermes.bridge._run_in_process_group", side_effect=subprocess.TimeoutExpired("plur", 5)), \
         patch("plur_hermes.bridge.time.sleep"):
        result = bridge.learn("a fact", force=True)
    assert result.get("timed_out") is True
    assert "id" not in result


@pytest.mark.skipif(not (os.path.isfile(CLI) and shutil.which("node")), reason="built CLI not available")
def test_end_to_end_flag_like_statement_is_stored_verbatim():
    d = tempfile.mkdtemp(prefix="plur-formal-argv-")
    try:
        with open(os.path.join(d, "config.yaml"), "w") as f:
            f.write("index: false\n")
        wrapper = os.path.join(d, "plur")
        with open(wrapper, "w") as f:
            f.write(f'#!/bin/sh\nexec node "{CLI}" "$@"\n')
        os.chmod(wrapper, 0o755)
        bridge = PlurBridge(plur_path=d) if "plur_path" in PlurBridge.__init__.__code__.co_varnames else PlurBridge()
        bridge._binary = wrapper
        bridge._plur_path = d
        stmt = "--dry-run=true is required for every deploy"
        result = bridge.learn(stmt, force=True)
        assert result.get("statement") == stmt, result
    finally:
        shutil.rmtree(d, ignore_errors=True)
