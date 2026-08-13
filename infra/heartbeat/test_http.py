"""pytest: HTTP integration tests for the heartbeat ingress (#613).

`validate()` is well covered by `test_server.py`. The HTTP layer around it was
not covered at all — and that layer is where #611's `ThreadingHTTPServer` +
`timeout` hardening lives, plus every rejection an untrusted caller can reach:
wrong path, wrong method, wrong Content-Type, oversized body, malformed JSON.

## Why these are hermetic

PR #604 had a version of these tests and they failed on a clean checkout:
`DATA_DIR` is a module-level constant resolved at IMPORT time, so patching
`os.environ` afterwards does not redirect it, and the server tried to write to
`/var/lib/plur-heartbeat` → `PermissionError`. The fix is to patch the resolved
attribute, not the environment it was resolved from:

    monkeypatch.setattr(server, "DATA_DIR", tmp_path)

Everything else follows from that: a real socket on port 0 (the OS picks a free
one, so parallel runs cannot collide), a real HTTP request, and assertions on
the file that actually gets written.
"""
import json
import os
import sys
import threading
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer

import pytest

sys.path.insert(0, os.path.dirname(__file__))

import server  # noqa: E402

VALID = {
    "install_id": "123e4567-e89b-4d3c-a456-426614174000",
    "version": "0.14.0",
    "platform": "linux",
    "date": "2026-07-17",
    "learn_count": 5,
    "recall_count": 10,
    "session_count": 2,
}


@pytest.fixture
def ingress(tmp_path, monkeypatch):
    """A live server writing into tmp_path. Yields (host, port, data_dir)."""
    # The attribute, not the environment variable — see module docstring.
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    # Port 0: the OS assigns a free port, so two test runs never contend.
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.HeartbeatHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield httpd.server_address[0], httpd.server_address[1], tmp_path
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)


def request(ingress, method="POST", path="/v1/heartbeat", body=None, headers=None):
    host, port, _ = ingress
    conn = HTTPConnection(host, port, timeout=5)
    try:
        payload = b"" if body is None else (
            body if isinstance(body, bytes) else json.dumps(body).encode()
        )
        hdrs = {"Content-Type": "application/json"}
        if headers is not None:
            hdrs = headers
        if payload:
            hdrs = {**hdrs, "Content-Length": str(len(payload))}
        conn.request(method, path, body=payload, headers=hdrs)
        resp = conn.getresponse()
        return resp.status, resp.read()
    finally:
        conn.close()


def test_valid_post_writes_a_line_and_returns_204(ingress):
    _, _, data_dir = ingress
    status, _ = request(ingress, body=VALID)
    assert status == 204

    written = list(data_dir.glob("*.jsonl"))
    assert len(written) == 1, f"expected one dated file, found {written}"
    # The stored line must be the payload, not a re-serialisation that drops or
    # reorders fields — downstream `query.py` parses these back.
    lines = written[0].read_text().strip().split("\n")
    assert len(lines) == 1
    assert json.loads(lines[0]) == VALID


def test_repeated_posts_append_rather_than_overwrite(ingress):
    _, _, data_dir = ingress
    for i in range(3):
        status, _ = request(ingress, body={**VALID, "learn_count": i})
        assert status == 204
    written = list(data_dir.glob("*.jsonl"))[0]
    assert len(written.read_text().strip().split("\n")) == 3


def test_oversized_body_is_rejected_before_it_is_read(ingress):
    _, _, data_dir = ingress
    # Length header over MAX_BODY: the guard exists so a hostile caller cannot
    # make the process read an unbounded body into memory.
    big = {**VALID, "install_id": "x" * (server.MAX_BODY + 100)}
    status, body = request(ingress, body=big)
    assert status == 400
    assert b"too large" in body
    assert list(data_dir.glob("*.jsonl")) == []


@pytest.mark.parametrize("method", ["GET", "HEAD"])
def test_non_post_methods_are_405(ingress, method):
    status, _ = request(ingress, method=method, body=None)
    assert status == 405


def test_missing_content_type_is_400(ingress):
    _, _, data_dir = ingress
    payload = json.dumps(VALID).encode()
    status, body = request(
        ingress, body=payload, headers={"Content-Length": str(len(payload))},
    )
    assert status == 400
    assert b"Content-Type" in body
    assert list(data_dir.glob("*.jsonl")) == []


def test_wrong_path_is_404(ingress):
    status, _ = request(ingress, path="/v1/something-else", body=VALID)
    assert status == 404


def test_malformed_json_is_400(ingress):
    _, _, data_dir = ingress
    status, body = request(ingress, body=b"{not json")
    assert status == 400
    assert b"invalid JSON" in body
    assert list(data_dir.glob("*.jsonl")) == []


def test_non_object_json_is_400(ingress):
    # `validate()` indexes the payload, so a bare list or string must be
    # rejected at the HTTP layer before it reaches it.
    status, body = request(ingress, body=[VALID])
    assert status == 400
    assert b"JSON object" in body


def test_invalid_payload_is_rejected_and_nothing_is_written(ingress):
    # The join between the two layers: a payload that parses as JSON but fails
    # `validate()` must not reach the file.
    _, _, data_dir = ingress
    status, _ = request(ingress, body={**VALID, "platform": "solaris"})
    assert status == 400
    assert list(data_dir.glob("*.jsonl")) == []


def test_access_log_is_suppressed(capsys, ingress):
    # `log_message` is overridden because the default access log contains the
    # client IP, and this service exists to collect telemetry WITHOUT
    # identifying who sent it.
    request(ingress, body=VALID)
    captured = capsys.readouterr()
    assert "127.0.0.1" not in captured.err
    assert "127.0.0.1" not in captured.out
