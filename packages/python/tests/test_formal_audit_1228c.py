"""Audit of #1228, non-core packages (1228-c), Python client.

* ``inject(task)`` passed the task as the first positional argument, so a task
  such as ``"--path=/elsewhere …"`` reached the CLI's global-flag parser. It now
  travels after ``--`` when it begins with ``-``; every other task keeps the
  old argv, so an older CLI (the npx fallback pin) behaves as before.
* ``--json`` was inserted before the FIRST ``"--"`` in the argv, which can be a
  flag's value; with a separator present it now goes straight after the
  command, and without one it stays last (the old argv).
"""
from __future__ import annotations

import subprocess

from plur_ai import Plur
from plur_ai import bridge


def _capture(monkeypatch, out='{"count":0}\n'):
    seen: dict = {}

    def fake(cmd, *, env, timeout, input=None):
        seen["cmd"] = cmd
        seen["input"] = input
        return subprocess.CompletedProcess(cmd, 0, out, "")

    monkeypatch.setattr(bridge, "_run_in_process_group", fake)
    return seen


def test_inject_flag_like_task_goes_after_separator(monkeypatch):
    seen = _capture(monkeypatch)
    Plur(binary="plur").inject("--path=/elsewhere how do we deploy", budget=500)
    cmd = seen["cmd"]
    sep = cmd.index("--")
    assert cmd[sep + 1:] == ["--path=/elsewhere how do we deploy"], cmd
    assert "--json" in cmd[:sep] and "--budget" in cmd[:sep]


def test_inject_ordinary_task_keeps_the_old_argv(monkeypatch):
    seen = _capture(monkeypatch)
    Plur(binary="plur").inject("how do we deploy", budget=500)
    assert seen["cmd"] == ["plur", "inject", "how do we deploy", "--budget", "500", "--json"]


def test_json_never_lands_between_a_flag_and_its_value(monkeypatch):
    seen = _capture(monkeypatch, out="{}\n")
    bridge.run_json(["learn", "x", "--rationale", "--", "--", "y"], binary="plur")
    cmd = seen["cmd"]
    i = cmd.index("--rationale")
    assert cmd[i + 1] == "--", cmd
    assert cmd[:3] == ["plur", "learn", "--json"]
