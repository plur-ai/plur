"""Security audit 2026-11-06: tool values must never re-point the PLUR store.

A model-supplied plur_ingest source of "--path=/elsewhere" (or a timeline /
similarity-search / forget value) reached the CLI's global parser, which
expanded it and overrode the --path the bridge was configured with: ingest
created a store at /elsewhere and wrote there while reporting saved:true.

Runs under pytest, or standalone without it:
    python3 -I test/test_flag_value_store_path.py
A stub `plur` executable on PATH records the argv it received; no real CLI,
store or network is touched.
"""
import json
import os
import stat
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from plur_hermes.bridge import PlurBridge, PlurBridgeError  # noqa: E402


# These tests point HOME/PLUR_PATH/PATH at a stub and switch PLUR_BRIDGE_RETRY
# off. Under pytest, put the environment back after each test so later test
# modules (the bridge lock-retry tests) see the real defaults.
try:
    import pytest as _pytest

    @_pytest.fixture(autouse=True)
    def _restore_environ():
        saved = dict(os.environ)
        yield
        os.environ.clear()
        os.environ.update(saved)
except ImportError:  # run as a plain script
    pass

_STUB = """#!/usr/bin/env python3
import json, os, sys
with open(os.environ["PLUR_STUB_LOG"], "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\\n")
print(json.dumps({"ok": True, "results": [], "episodes": [], "count": 0}))
"""


class _Env:
    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix="plur-v22-")
        self.bin = os.path.join(self.tmp, "bin")
        os.makedirs(self.bin)
        stub = os.path.join(self.bin, "plur")
        with open(stub, "w") as f:
            f.write(_STUB)
        os.chmod(stub, os.stat(stub).st_mode | stat.S_IEXEC)
        self.log = os.path.join(self.tmp, "argv.log")
        self.store = os.path.join(self.tmp, "real-store")
        os.environ["PLUR_STUB_LOG"] = self.log
        os.environ["HOME"] = self.tmp
        os.environ["PLUR_PATH"] = self.store
        os.environ["PLUR_BRIDGE_RETRY"] = "false"
        os.environ["PATH"] = self.bin + os.pathsep + os.environ.get("PATH", "")
        self.bridge = PlurBridge()
        self.bridge._binary = stub
        self.bridge._plur_path = self.store

    def argvs(self):
        if not os.path.exists(self.log):
            return []
        with open(self.log) as f:
            return [json.loads(line) for line in f if line.strip()]


def _paths(argv):
    """Every directory the CLI's global parser would read as --path."""
    out = []
    head = argv[: argv.index("--")] if "--" in argv else argv
    for i, tok in enumerate(head):
        if tok == "--path" and i + 1 < len(head):
            out.append(head[i + 1])
        elif tok.startswith("--path="):
            out.append(tok.split("=", 1)[1])
    return out


def _raises(fn):
    try:
        fn()
    except PlurBridgeError:
        return True
    return False


def test_ingest_flag_value_cannot_repoint_store():
    env = _Env()
    assert _raises(lambda: env.bridge.ingest("We always run tests.", source="--path=/tmp/other"))
    assert _raises(lambda: env.bridge.ingest("We always run tests.", scope="--path=/tmp/other"))
    assert _raises(lambda: env.bridge.ingest("We always run tests.", domain="--path=/tmp/other"))
    assert env.argvs() == []  # refused before the CLI ran


def test_ingest_content_travels_after_separator():
    env = _Env()
    env.bridge.ingest("--path=/tmp/other we always run tests", source="chat")
    (argv,) = env.argvs()
    assert _paths(argv) == [env.store]
    assert argv[-2:] == ["--", "--path=/tmp/other we always run tests"]


def test_timeline_query_travels_after_separator():
    env = _Env()
    env.bridge.timeline(query="--path=/tmp/other")
    (argv,) = env.argvs()
    assert _paths(argv) == [env.store]
    assert argv[-2:] == ["--", "--path=/tmp/other"]


def test_similarity_search_query_and_scope():
    env = _Env()
    env.bridge.similarity_search("--path=/tmp/other")
    (argv,) = env.argvs()
    assert _paths(argv) == [env.store]
    assert argv[-2:] == ["--", "--path=/tmp/other"]
    assert _raises(lambda: env.bridge.similarity_search("q", scope="--path=/tmp/other"))


def test_forget_target_and_reason():
    env = _Env()
    env.bridge.forget(search="--path=/tmp/other")
    env.bridge.forget(id="ENG-2026-01-01-001")
    a, b = env.argvs()
    assert _paths(a) == [env.store] and a[-3:] == ["--search", "--", "--path=/tmp/other"]
    assert _paths(b) == [env.store] and b[-2:] == ["--", "ENG-2026-01-01-001"]
    assert _raises(lambda: env.bridge.forget(id="ENG-1", reason="--path=/tmp/other"))


def test_feedback_promote_and_learn_flag_values_refused():
    env = _Env()
    assert _raises(lambda: env.bridge.feedback(id="--path=/tmp/other", signal="positive"))
    assert _raises(lambda: env.bridge.promote("--path=/tmp/other"))
    assert _raises(lambda: env.bridge.learn("a fact", domain="--path=/tmp/other", force=True))
    assert _raises(lambda: env.bridge.learn("a fact", source="--path=/tmp/other", force=True))
    assert env.argvs() == []


def test_ordinary_values_still_work():
    env = _Env()
    env.bridge.ingest("We always run tests.", source="chat", scope="global", domain="eng")
    env.bridge.feedback(id="ENG-1", signal="positive")
    for argv in env.argvs():
        assert _paths(argv) == [env.store]


if __name__ == "__main__":
    failed = 0
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    for name, fn in tests:
        try:
            fn()
            print(f"PASS {name}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {name}: {type(e).__name__}: {e}")
    print(f"{len(tests) - failed} passed, {failed} failed ({len(tests)})")
    sys.exit(1 if failed else 0)
