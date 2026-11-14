"""Security audit 2026-11-06: a tool value must never re-point the PLUR store (--path)."""
import json
from unittest.mock import MagicMock, patch

import pytest

from plur_hermes.bridge import PlurBridge, PlurBridgeError

EVIL = "--path=/tmp/other"


def _bridge():
    bridge = PlurBridge()
    bridge._binary = "/usr/local/bin/plur"
    bridge._plur_path = "/tmp/real-store"
    return bridge


def _run(fn):
    ok = MagicMock(returncode=0, stdout=json.dumps({"ok": True}), stderr="")
    with patch("plur_hermes.bridge._run_in_process_group", return_value=ok) as run:
        fn(_bridge())
    return run


@pytest.mark.parametrize("fn", [
    lambda b: b.ingest("x", source=EVIL),
    lambda b: b.ingest("x", scope=EVIL),
    lambda b: b.similarity_search("q", scope=EVIL),
    lambda b: b.forget(id="ENG-1", reason=EVIL),
    lambda b: b.feedback(id=EVIL, signal="positive"),
    lambda b: b.promote(EVIL),
    lambda b: b.learn("a fact", source=EVIL, force=True),
])
def test_flag_value_that_reads_as_a_flag_is_refused(fn):
    with pytest.raises(PlurBridgeError):
        _run(fn)


def test_model_supplied_positional_travels_after_separator():
    argv = _run(lambda b: b.ingest(EVIL, source="chat")).call_args[0][0]
    assert argv[-2:] == ["--", EVIL]
    assert EVIL not in argv[:-1]


def test_ordinary_values_still_work():
    argv = _run(lambda b: b.ingest("We always run tests.", source="chat", scope="global")).call_args[0][0]
    assert argv[argv.index("--path") + 1] == "/tmp/real-store"
