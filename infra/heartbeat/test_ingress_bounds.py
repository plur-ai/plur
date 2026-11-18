"""Security audit 2026-11-06: unauthenticated ingress retains bounded data."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import server  # noqa: E402

BASE = {"version": "0.23.0", "platform": "linux", "date": "2026-11-06",
        "learn_count": 1, "recall_count": 1, "session_count": 1}


def _rec(i):
    return {**BASE, "install_id": f"123e4567-e89b-4d3c-a456-{i:012d}"}


def test_oversized_counts_and_versions_rejected():
    assert server.validate({**_rec(3), "learn_count": 10**30}) is not None
    assert server.validate({**_rec(3), "version": "1.0.0-" + "a" * 900}) is not None
    assert server.validate(_rec(3)) is None


def test_unhashable_platform_and_trailing_newline_rejected():
    assert server.validate({**_rec(4), "platform": {}}) is not None
    assert server.validate({**_rec(4), "version": "1.2.3\n"}) is not None
    assert server.validate({**_rec(4), "date": "2026-11-06\n"}) is not None

