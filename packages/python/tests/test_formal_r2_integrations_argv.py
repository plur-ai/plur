"""Formal verification round 2 (R2-Integrations follow-up): a recall query is data.

A query that begins with ``-`` could be read by the CLI as a flag, so it travels
after ``--`` (which ``plur recall`` honours); ``--json`` must stay before the
separator. Every other query keeps its argv shape. Same rule as the hermes
bridge (spec/formal/PlurSpec/R2Integrations.lean §2, ``recall_query_verbatim``).
"""
from __future__ import annotations

import subprocess

from plur_ai import Plur
from plur_ai import bridge


def _capture(monkeypatch):
    seen: dict = {}

    def fake(cmd, *, env, timeout, input=None):
        seen["cmd"] = cmd
        return subprocess.CompletedProcess(cmd, 0, '{"results":[]}\n', "")

    monkeypatch.setattr(bridge, "_run_in_process_group", fake)
    return seen


def test_dash_query_goes_after_separator_fast(monkeypatch):
    seen = _capture(monkeypatch)
    Plur(binary="plur").recall("--dry-run conventions", limit=3)
    cmd = seen["cmd"]
    sep = cmd.index("--")
    assert cmd[sep + 1:] == ["--dry-run conventions"], cmd
    assert "--json" in cmd[:sep] and "--fast" in cmd[:sep] and "--limit" in cmd[:sep]


def test_dash_query_goes_after_separator_hybrid(monkeypatch):
    seen = _capture(monkeypatch)
    Plur(binary="plur").recall_hybrid("-x marks the spot")
    cmd = seen["cmd"]
    sep = cmd.index("--")
    assert cmd[sep + 1:] == ["-x marks the spot"], cmd
    assert "--json" in cmd[:sep]


def test_ordinary_query_argv_unchanged(monkeypatch):
    seen = _capture(monkeypatch)
    Plur(binary="plur").recall("deploy checklist", limit=3)
    assert seen["cmd"][-6:] == ["recall", "--fast", "deploy checklist", "--limit", "3", "--json"]
