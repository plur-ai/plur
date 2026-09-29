"""Audit of #1228, non-core packages (1228-c), Hermes bridge.

Replayed from the audit's unconfirmed list:

* inject / capture passed free text (a user message, a turn summary) as the
  first positional argument. A message such as "--path=/elsewhere …" reached
  the CLI's global-flag parser: it selected, and created, another store, or the
  CLI exited 1 and the turn had no memory. Text that could be read as a flag now
  travels after `--` (inject) or on stdin (capture); every other text keeps its
  argv shape, so an older CLI behaves exactly as before.
* call() inserted `--path` before the FIRST `--` in the argv, which could be a
  flag's VALUE (`forget(search="--")`), splitting the flag from its value. It
  now goes straight after `--json`, before any argument.
"""
import json
import os
import shutil
import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from plur_hermes.bridge import PlurBridge


def _ok(payload):
    m = MagicMock()
    m.returncode = 0
    m.stdout = json.dumps(payload)
    m.stderr = ""
    return m


def _bridge(path=None):
    b = PlurBridge()
    b._binary = "/usr/local/bin/plur"
    b._plur_path = path
    return b


def test_inject_flag_like_text_goes_after_separator():
    b = _bridge()
    text = "--path=/elsewhere how do we deploy"
    with patch("plur_hermes.bridge._run_in_process_group", return_value=_ok({"count": 0})) as run:
        b.inject(text)
    cmd = run.call_args[0][0]
    assert cmd[cmd.index("--") + 1] == text
    assert cmd.index(text) > cmd.index("--")


def test_inject_ordinary_text_keeps_the_old_argv():
    b = _bridge()
    with patch("plur_hermes.bridge._run_in_process_group", return_value=_ok({"count": 0})) as run:
        b.inject("how do we deploy", budget=500, fast=True)
    assert run.call_args[0][0] == ["/usr/local/bin/plur", "inject", "--json", "how do we deploy",
                                   "--budget", "500", "--fast"]


def test_capture_flag_like_summary_goes_on_stdin():
    b = _bridge()
    text = "--json is what the CLI printed"
    with patch("plur_hermes.bridge._run_in_process_group", return_value=_ok({"id": "EP-1"})) as run:
        b.capture(text, session="s1")
    cmd = run.call_args[0][0]
    assert text not in cmd
    assert run.call_args.kwargs.get("input") == text


def test_capture_ordinary_summary_keeps_the_old_argv():
    b = _bridge()
    with patch("plur_hermes.bridge._run_in_process_group", return_value=_ok({"id": "EP-1"})) as run:
        b.capture("deployed the fix", session="s1")
    assert run.call_args[0][0] == ["/usr/local/bin/plur", "capture", "--json", "deployed the fix",
                                   "--agent", "hermes", "--session", "s1"]


def test_path_goes_before_every_argument_not_before_a_value():
    b = _bridge(path="/store")
    with patch("plur_hermes.bridge._run_in_process_group", return_value=_ok({"success": True})) as run:
        b.forget(search="--")
    cmd = run.call_args[0][0]
    assert cmd[:5] == ["/usr/local/bin/plur", "forget", "--json", "--path", "/store"]
    i = cmd.index("--search")
    assert cmd[i + 1] == "--"


def test_path_stays_before_a_real_separator():
    b = _bridge(path="/store")
    with patch("plur_hermes.bridge._run_in_process_group", return_value=_ok({"results": []})) as run:
        b.recall("-x marks the spot")
    cmd = run.call_args[0][0]
    assert cmd.index("--path") < cmd.index("--")
    assert cmd[-2:] == ["--", "-x marks the spot"]


_CLI = Path(__file__).resolve().parents[2] / "cli" / "dist" / "index.js"


@pytest.mark.skipif(shutil.which("node") is None or not _CLI.exists(), reason="needs node and a built CLI")
def test_real_cli_inject_does_not_follow_a_path_in_the_text(tmp_path):
    home = tmp_path / "home"
    store = home / ".plur"
    store.mkdir(parents=True)
    (store / "config.yaml").write_text("embeddings:\n  enabled: false\nindex: false\n")
    elsewhere = tmp_path / "elsewhere"
    wrapper = tmp_path / "plur"
    wrapper.write_text(f"#!/bin/sh\nexec node {_CLI} \"$@\"\n")
    wrapper.chmod(0o755)
    b = PlurBridge()
    b._binary = str(wrapper)
    b._plur_path = str(store)
    with patch.dict(os.environ, {"HOME": str(home), "USERPROFILE": str(home)}):
        b.inject(f"--path={elsewhere} how do we deploy", fast=True)  # before: CLI exit 1
    assert not any(p.name.startswith("elsewhere") for p in tmp_path.iterdir())
