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


@pytest.mark.parametrize("payload", [
    {**VALID, "platform": []}, {**VALID, "platform": {}},
    {**VALID, "date": "2026-02-31"}, {**VALID, "date": "2026-07-17\n"},
    {**VALID, "install_id": VALID["install_id"] + "\n"},
    {**VALID, "version": "1.0.0\n"}, b"\xff", b"[" * 1000,
])
def test_adversarial_payload_returns_400_without_writing(ingress, payload):
    status, _ = request(ingress, body=payload)
    assert status == 400
    assert list(ingress[2].glob("*.jsonl")) == []


@pytest.mark.parametrize("length", ["-1", "garbage", "1.5", "999999999999999999999"])
def test_malformed_length_is_bounded(ingress, length):
    conn = HTTPConnection(ingress[0], ingress[1], timeout=2)
    try:
        conn.request("POST", "/v1/heartbeat", headers={"Content-Type": "application/json", "Content-Length": length})
        assert conn.getresponse().status == 400
    finally:
        conn.close()


def test_fsync_failure_is_not_acknowledged(ingress, monkeypatch):
    def fail(_fd):
        raise OSError("injected disk failure")
    monkeypatch.setattr(server.os, "fsync", fail)
    status, _ = request(ingress, body=VALID)
    assert status == 503


@pytest.mark.parametrize("failure", ["short", "error"])
def test_failed_partial_append_cannot_hide_the_next_accepted_record(ingress, monkeypatch, failure):
    real_write = server.os.write

    def partial(fd, data):
        real_write(fd, data[:9])
        if failure == "short":
            return 9
        raise OSError("injected interrupted write")

    with monkeypatch.context() as patch:
        patch.setattr(server.os, "write", partial)
        assert request(ingress, body=VALID)[0] == 503
    accepted = {**VALID, "learn_count": 71}
    assert request(ingress, body=accepted)[0] == 204
    lines = next(ingress[2].glob("*.jsonl")).read_text().splitlines()
    assert json.loads(lines[-1]) == accepted


def test_existing_unterminated_record_is_preserved_on_append(ingress):
    day = server.datetime.now(server.timezone.utc).strftime("%Y-%m-%d")
    target = ingress[2] / f"{day}.jsonl"
    target.write_text(json.dumps(VALID))
    accepted = {**VALID, "learn_count": 72}
    assert request(ingress, body=accepted)[0] == 204
    assert [json.loads(line) for line in target.read_text().splitlines()] == [VALID, accepted]


def test_concurrent_appends_cannot_interleave_partial_writes(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    real_write = server.os.write
    entered = threading.Event()
    release = threading.Event()

    def delayed_write(fd, data):
        split = len(data) // 2
        real_write(fd, data[:split])
        entered.set()
        assert release.wait(3)
        real_write(fd, data[split:])
        return len(data)

    target = tmp_path / "concurrent.jsonl"
    monkeypatch.setattr(server.os, "write", delayed_write)
    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(server.append_record, target, VALID)
        assert entered.wait(3)
        second = executor.submit(server.append_record, target, {**VALID, "learn_count": 73})
        try:
            assert not second.done()
        finally:
            release.set()
        first.result(timeout=3)
        second.result(timeout=3)
    assert [json.loads(line)["learn_count"] for line in target.read_text().splitlines()] == [5, 73]


def test_directory_sync_failure_is_not_acknowledged(ingress, monkeypatch):
    import stat
    real_fsync = server.os.fsync

    def fail_directory(fd):
        if stat.S_ISDIR(os.fstat(fd).st_mode):
            raise OSError("injected directory sync failure")
        real_fsync(fd)

    monkeypatch.setattr(server.os, "fsync", fail_directory)
    assert request(ingress, body=VALID)[0] == 503


def test_ancestor_sync_failure_is_rechecked_after_interrupted_directory_creation(tmp_path, monkeypatch):
    target = tmp_path / "new" / "nested" / "records.jsonl"
    ancestor = tmp_path.stat()
    real_fsync = server.os.fsync

    def fail_ancestor(fd):
        current = os.fstat(fd)
        if (current.st_dev, current.st_ino) == (ancestor.st_dev, ancestor.st_ino):
            raise OSError("injected ancestor sync failure")
        real_fsync(fd)

    monkeypatch.setattr(server.os, "fsync", fail_ancestor)
    for _ in range(2):
        with pytest.raises(OSError, match="ancestor sync"):
            server.append_record(target, VALID)
    monkeypatch.setattr(server.os, "fsync", real_fsync)
    server.append_record(target, VALID)
    assert [json.loads(line) for line in target.read_text().splitlines()] == [VALID] * 3


def test_retry_delivery_is_counted_once_across_restart_days(ingress, monkeypatch):
    import query
    monkeypatch.setattr(query, "DATA_DIR", ingress[2])
    payload = {**VALID, "date": server.datetime.now(server.timezone.utc).date().isoformat()}
    headers = {"Content-Type": "application/json", "Idempotency-Key": "a23e4567-e89b-4d3c-a456-426614174000"}
    assert request(ingress, body=payload, headers=headers)[0] == 204
    # Simulate response loss followed by retry. Both arrivals remain durable.
    assert request(ingress, body=payload, headers=headers)[0] == 204
    written = next(ingress[2].glob("*.jsonl"))
    rows = written.read_text().splitlines()
    assert len(rows) == 2
    # The same receipt may be resent after midnight or process restart.
    previous = server.datetime.now(server.timezone.utc).date() - query.timedelta(days=1)
    (ingress[2] / f"{previous.isoformat()}.jsonl").write_text(rows[0] + "\n")
    today = server.datetime.now(server.timezone.utc).date()
    result = query.load_records(previous, today)
    assert len(result) == 1
    assert result[0]["learn_count"] == VALID["learn_count"]


def test_conflicting_delivery_cannot_produce_plausible_metrics(ingress, monkeypatch):
    import query
    monkeypatch.setattr(query, "DATA_DIR", ingress[2])
    payload = {**VALID, "date": server.datetime.now(server.timezone.utc).date().isoformat()}
    headers = {"Content-Type": "application/json", "Idempotency-Key": "b23e4567-e89b-4d3c-a456-426614174000"}
    assert request(ingress, body=payload, headers=headers)[0] == 204
    assert request(ingress, body={**payload, "learn_count": 99}, headers=headers)[0] == 204
    assert request(ingress, body={**payload, "learn_count": 2})[0] == 204
    today = server.datetime.now(server.timezone.utc).date()
    records = query.load_records(today, today)
    assert [record["learn_count"] for record in records] == [2]
    assert records.quality == {"status": "partial", "invalid_lines": 0, "conflicting_deliveries": 1}
    assert query.summary_stats()["data_quality"] == records.quality


def test_invalid_delivery_identity_is_refused_before_persistence(ingress):
    assert request(ingress, body=VALID, headers={"Content-Type": "application/json", "Idempotency-Key": "../invalid"})[0] == 400
    assert list(ingress[2].glob("*.jsonl")) == []


def test_backlog_and_future_activity_do_not_inflate_current_metrics(ingress, monkeypatch):
    import query
    monkeypatch.setattr(query, "DATA_DIR", ingress[2])
    today = server.datetime.now(server.timezone.utc).date()
    for offset in [-60, 60, 0]:
        payload = {**VALID, "date": (today + query.timedelta(days=offset)).isoformat()}
        assert request(ingress, body=payload)[0] == 204
    records = query.load_records(today - query.timedelta(days=6), today)
    assert len(records) == 1
    assert records[0]["date"] == today.isoformat()
    assert records.quality["status"] == "complete"


def test_metrics_windows_use_the_same_utc_day_as_the_collector(tmp_path, monkeypatch):
    import query
    from datetime import date, datetime, timezone

    class LocalDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 9, 9)

    class UtcClock(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 9, 8, 22, 30, tzinfo=timezone.utc)

    monkeypatch.setattr(query, "date", LocalDate)
    monkeypatch.setattr(query, "datetime", UtcClock)
    monkeypatch.setattr(query, "DATA_DIR", tmp_path)
    (tmp_path / "2026-09-08.jsonl").write_text(json.dumps({**VALID, "date": "2026-09-08"}) + "\n")
    assert query.weekly_active_count()["until"] == "2026-09-08"
    assert query.summary_stats()["until"] == "2026-09-08"
    assert query.mau_stats()["date"] == "2026-09-08"
    assert query.mau_stats()["dau_1d"] == 1
