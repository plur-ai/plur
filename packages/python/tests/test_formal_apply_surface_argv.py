"""Formal-verification apply phase, decision S4 (3), 2026-09-26.

``run_json`` gains an ``input`` parameter and ``Plur.learn`` sends a statement
that starts with ``-`` on stdin, the same rule as the hermes bridge
(spec/formal/findings/adapters.md §7, PlurSpec/Adapters.lean
``bridge_statement_verbatim``). In argv such a statement is read as a flag:
refused, or — with ``--path=…`` — it selected a store.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from plur_ai import Plur
from plur_ai import bridge

REPO = Path(__file__).resolve().parents[3]
CLI = REPO / "packages" / "cli" / "dist" / "index.js"


def _capture(monkeypatch):
    seen: dict = {}

    def fake(cmd, *, env, timeout, input=None):
        seen["cmd"] = cmd
        seen["input"] = input
        return subprocess.CompletedProcess(cmd, 0, '{"id":"ENG-X"}\n', "")

    monkeypatch.setattr(bridge, "_run_in_process_group", fake)
    return seen


def test_run_json_forwards_input(monkeypatch):
    seen = _capture(monkeypatch)
    bridge.run_json(["learn"], binary="plur", input="--x")
    assert seen["input"] == "--x"


def test_flag_like_statement_goes_on_stdin(monkeypatch):
    seen = _capture(monkeypatch)
    st = "--dry-run=true is required for every deploy"
    Plur(binary="plur").learn(st, scope="global")
    assert st not in seen["cmd"]
    assert seen["input"] == st
    assert seen["cmd"][:2] == ["plur", "learn"]


def test_ordinary_statement_stays_in_argv(monkeypatch):
    seen = _capture(monkeypatch)
    Plur(binary="plur").learn("Use pnpm, not npm")
    assert seen["cmd"][:3] == ["plur", "learn", "Use pnpm, not npm"]
    assert seen["input"] is None


@pytest.mark.skipif(not (CLI.is_file() and shutil.which("node")), reason="built CLI not available")
def test_end_to_end_flag_like_statements_stored_verbatim():
    d = tempfile.mkdtemp(prefix="plur-py-argv-")
    try:
        Path(d, "config.yaml").write_text("index: false\n")
        shim = Path(d, "plur")
        shim.write_text(f'#!/bin/sh\nexec node "{CLI}" "$@"\n')
        shim.chmod(0o755)
        other = Path(d, "other")
        old_home = os.environ.get("HOME")
        os.environ["HOME"] = d
        try:
            p = Plur(path=d, binary=str(shim), timeout=60)
            p.learn("--dry-run=true is required for every deploy", scope="global")
            p.learn(f"--path={other} holds the fixtures", scope="global")
        finally:
            if old_home is None:
                os.environ.pop("HOME", None)
            else:
                os.environ["HOME"] = old_home
        text = Path(d, "engrams.yaml").read_text()
        assert "--dry-run=true is required for every deploy" in text
        assert "holds the fixtures" in text
        assert not other.exists()
    finally:
        shutil.rmtree(d, ignore_errors=True)
