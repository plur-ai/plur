"""
pytest coverage for heartbeat server.py — validate() accept/reject matrix + HTTP integration.
Closes #598.
"""
import json
import threading
import urllib.request
from http.server import HTTPServer

import pytest

from server import (
    MAX_BODY,
    HeartbeatHandler,
    validate,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

VALID = {
    "install_id": "12345678-1234-4abc-89ab-123456789012",
    "version": "0.14.0",
    "platform": "linux",
    "date": "2026-07-16",
    "learn_count": 3,
    "recall_count": 7,
    "session_count": 2,
}


def _payload(**overrides):
    p = dict(VALID)
    p.update(overrides)
    return p


def _drop(key):
    p = dict(VALID)
    del p[key]
    return p


# ---------------------------------------------------------------------------
# validate() unit tests
# ---------------------------------------------------------------------------


class TestValidateAccept:
    def test_valid_payload_returns_none(self):
        assert validate(VALID) is None

    def test_zero_counters_are_valid(self):
        assert validate(_payload(learn_count=0, recall_count=0, session_count=0)) is None

    def test_prerelease_version_is_valid(self):
        assert validate(_payload(version="1.0.0-beta.1")) is None

    def test_darwin_platform(self):
        assert validate(_payload(platform="darwin")) is None

    def test_win32_platform(self):
        assert validate(_payload(platform="win32")) is None

    def test_uuid_case_insensitive(self):
        assert validate(_payload(install_id="12345678-1234-4ABC-89AB-123456789012")) is None


class TestValidateRejectMissingFields:
    @pytest.mark.parametrize("key", list(VALID.keys()))
    def test_missing_required_field(self, key):
        err = validate(_drop(key))
        assert err is not None
        assert "missing" in err
        assert key in err


class TestValidateRejectUnknownFields:
    def test_extra_field_is_rejected(self):
        err = validate(_payload(extra_field="sneaky"))
        assert err is not None
        assert "unknown" in err
        assert "extra_field" in err

    def test_multiple_unknown_fields(self):
        err = validate(_payload(a=1, b=2))
        assert err is not None
        assert "unknown" in err


class TestValidateRejectBadInstallId:
    def test_not_a_string(self):
        err = validate(_payload(install_id=12345))
        assert err is not None
        assert "install_id" in err

    def test_not_uuid_format(self):
        err = validate(_payload(install_id="not-a-uuid"))
        assert err is not None
        assert "install_id" in err

    def test_uuid_v1_rejected(self):
        # UUIDv1 has a different variant bit pattern
        err = validate(_payload(install_id="12345678-1234-1234-8abc-123456789012"))
        assert err is not None
        assert "install_id" in err


class TestValidateRejectBadVersion:
    def test_not_a_string(self):
        err = validate(_payload(version=14))
        assert err is not None
        assert "version" in err

    def test_missing_patch(self):
        err = validate(_payload(version="0.14"))
        assert err is not None
        assert "version" in err

    def test_leading_v_rejected(self):
        err = validate(_payload(version="v0.14.0"))
        assert err is not None
        assert "version" in err


class TestValidateRejectBadPlatform:
    def test_unknown_platform(self):
        err = validate(_payload(platform="windows"))
        assert err is not None
        assert "platform" in err

    def test_empty_platform(self):
        err = validate(_payload(platform=""))
        assert err is not None
        assert "platform" in err


class TestValidateRejectBadDate:
    def test_not_a_string(self):
        err = validate(_payload(date=20260716))
        assert err is not None
        assert "date" in err

    def test_wrong_format(self):
        err = validate(_payload(date="07/16/2026"))
        assert err is not None
        assert "date" in err

    def test_iso_datetime_rejected(self):
        err = validate(_payload(date="2026-07-16T00:00:00Z"))
        assert err is not None
        assert "date" in err


class TestValidateRejectBadCounters:
    @pytest.mark.parametrize("field", ["learn_count", "recall_count", "session_count"])
    def test_negative_counter(self, field):
        err = validate(_payload(**{field: -1}))
        assert err is not None
        assert field in err

    @pytest.mark.parametrize("field", ["learn_count", "recall_count", "session_count"])
    def test_float_counter(self, field):
        err = validate(_payload(**{field: 1.5}))
        assert err is not None
        assert field in err

    @pytest.mark.parametrize("field", ["learn_count", "recall_count", "session_count"])
    def test_string_counter(self, field):
        err = validate(_payload(**{field: "5"}))
        assert err is not None
        assert field in err


# ---------------------------------------------------------------------------
# HTTP integration tests — body cap and non-validate paths
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def server_url():
    """Spin up a real ThreadingHTTPServer on a random port for integration tests."""
    httpd = HTTPServer(("127.0.0.1", 0), HeartbeatHandler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{port}"
    httpd.shutdown()


def _post(url, body: bytes, headers: dict = None):
    req = urllib.request.Request(
        url + "/v1/heartbeat",
        data=body,
        headers={"Content-Type": "application/json", **(headers or {})},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


class TestHTTPIntegration:
    def test_valid_payload_returns_204(self, server_url):
        body = json.dumps(VALID).encode()
        status, _ = _post(server_url, body)
        assert status == 204

    def test_oversized_body_returns_400(self, server_url):
        oversized = b"x" * (MAX_BODY + 1)
        req = urllib.request.Request(
            server_url + "/v1/heartbeat",
            data=None,
            headers={
                "Content-Type": "application/json",
                "Content-Length": str(MAX_BODY + 1),
            },
            method="POST",
        )
        req.data = oversized
        try:
            with urllib.request.urlopen(req):
                pass
            pytest.fail("Expected HTTPError")
        except urllib.error.HTTPError as e:
            assert e.code == 400

    def test_invalid_json_returns_400(self, server_url):
        status, body = _post(server_url, b"{not json}")
        assert status == 400

    def test_wrong_path_returns_404(self, server_url):
        req = urllib.request.Request(
            server_url + "/v1/other",
            data=json.dumps(VALID).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req):
                pass
            pytest.fail("Expected HTTPError")
        except urllib.error.HTTPError as e:
            assert e.code == 404

    def test_wrong_content_type_returns_400(self, server_url):
        body = json.dumps(VALID).encode()
        req = urllib.request.Request(
            server_url + "/v1/heartbeat",
            data=body,
            headers={"Content-Type": "text/plain"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req):
                pass
            pytest.fail("Expected HTTPError")
        except urllib.error.HTTPError as e:
            assert e.code == 400

    def test_validation_error_returns_400(self, server_url):
        bad = _payload(platform="unknown_os")
        status, _ = _post(server_url, json.dumps(bad).encode())
        assert status == 400

    def test_get_returns_405(self, server_url):
        req = urllib.request.Request(
            server_url + "/v1/heartbeat",
            method="GET",
        )
        try:
            with urllib.request.urlopen(req):
                pass
            pytest.fail("Expected HTTPError")
        except urllib.error.HTTPError as e:
            assert e.code == 405
