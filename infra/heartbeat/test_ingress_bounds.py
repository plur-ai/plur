"""Security audit 2026-11-06: unauthenticated ingress retains bounded data."""
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
import server  # noqa: E402

BASE = {"version": "0.23.0", "platform": "linux", "date": "2026-11-06",
        "learn_count": 1, "recall_count": 1, "session_count": 1}


def _rec(i):
    return {**BASE, "install_id": f"123e4567-e89b-4d3c-a456-{i:012d}"}


def _reset():
    server._seen_day = None
    server._seen_ids = set()


def test_repeat_heartbeat_same_install_same_day_is_not_retained_twice():
    _reset()
    with tempfile.TemporaryDirectory() as d:
        for _ in range(50):
            server.persist(_rec(1), Path(d), "2026-11-06")
        assert len(Path(d, "2026-11-06.jsonl").read_text().splitlines()) == 1


def test_dedupe_survives_restart():
    _reset()
    with tempfile.TemporaryDirectory() as d:
        server.persist(_rec(2), Path(d), "2026-11-06")
        _reset()
        assert server.persist(_rec(2), Path(d), "2026-11-06") == "duplicate"


def test_daily_file_is_capped():
    _reset()
    old = server.MAX_DAILY_BYTES
    server.MAX_DAILY_BYTES = 2000
    try:
        with tempfile.TemporaryDirectory() as d:
            results = [server.persist(_rec(i), Path(d), "2026-11-06") for i in range(100)]
            assert "full" in results
            assert Path(d, "2026-11-06.jsonl").stat().st_size <= 2000
    finally:
        server.MAX_DAILY_BYTES = old


def test_oversized_counts_and_versions_rejected():
    assert server.validate({**_rec(3), "learn_count": 10**30}) is not None
    assert server.validate({**_rec(3), "version": "1.0.0-" + "a" * 900}) is not None
    assert server.validate(_rec(3)) is None


def test_unhashable_platform_and_trailing_newline_rejected():
    assert server.validate({**_rec(4), "platform": {}}) is not None
    assert server.validate({**_rec(4), "version": "1.2.3\n"}) is not None
    assert server.validate({**_rec(4), "date": "2026-11-06\n"}) is not None


def test_units_are_sandboxed_and_deploy_refuses_root():
    here = os.path.dirname(__file__)
    for unit in ("plur-heartbeat.service", "plur-metrics.service"):
        text = open(os.path.join(here, unit)).read()
        for d in ("NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes", "ReadWritePaths="):
            assert d in text, (unit, d)
    deploy = open(os.path.join(here, "deploy.sh")).read()
    assert "refusing to run the internet-facing heartbeat as root" in deploy
    assert '${DEPLOY_USER:-$(whoami)}' not in deploy


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
