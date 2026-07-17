"""pytest: validate() accept/reject matrix for server.py"""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

from server import validate

VALID = {
    "install_id": "123e4567-e89b-4d3c-a456-426614174000",
    "version": "0.14.0",
    "platform": "linux",
    "date": "2026-07-17",
    "learn_count": 5,
    "recall_count": 10,
    "session_count": 2,
}


def _patch(**kwargs):
    return {**VALID, **kwargs}


def test_valid_payload():
    assert validate(VALID) is None


def test_valid_prerelease_version():
    assert validate(_patch(version="1.0.0-beta.1")) is None


def test_valid_darwin():
    assert validate(_patch(platform="darwin")) is None


def test_valid_win32():
    assert validate(_patch(platform="win32")) is None


def test_valid_zero_counts():
    assert validate(_patch(learn_count=0, recall_count=0, session_count=0)) is None


def test_missing_install_id():
    p = {k: v for k, v in VALID.items() if k != "install_id"}
    err = validate(p)
    assert err and "install_id" in err


def test_missing_version():
    p = {k: v for k, v in VALID.items() if k != "version"}
    err = validate(p)
    assert err and "version" in err


def test_missing_multiple_fields():
    p = {k: v for k, v in VALID.items() if k not in ("learn_count", "recall_count")}
    err = validate(p)
    assert err and "missing" in err


def test_unknown_field_rejected():
    err = validate(_patch(extra_field="surprise"))
    assert err and "unknown" in err


def test_multiple_unknown_fields():
    err = validate(_patch(foo="a", bar="b"))
    assert err and "unknown" in err and "bar" in err and "foo" in err


def test_bad_uuid_wrong_version():
    err = validate(_patch(install_id="123e4567-e89b-3d3c-a456-426614174000"))  # v3, not v4
    assert err and "install_id" in err


def test_bad_uuid_not_uuid():
    err = validate(_patch(install_id="not-a-uuid"))
    assert err and "install_id" in err


def test_bad_uuid_type():
    err = validate(_patch(install_id=12345))
    assert err and "install_id" in err


def test_bad_semver():
    err = validate(_patch(version="1.0"))
    assert err and "version" in err


def test_bad_semver_type():
    err = validate(_patch(version=14))
    assert err and "version" in err


def test_unknown_platform():
    err = validate(_patch(platform="freebsd"))
    assert err and "platform" in err


def test_malformed_date():
    err = validate(_patch(date="17-07-2026"))
    assert err and "date" in err


def test_date_type():
    err = validate(_patch(date=20260717))
    assert err and "date" in err


def test_negative_learn_count():
    err = validate(_patch(learn_count=-1))
    assert err and "learn_count" in err


def test_negative_recall_count():
    err = validate(_patch(recall_count=-5))
    assert err and "recall_count" in err


def test_negative_session_count():
    err = validate(_patch(session_count=-1))
    assert err and "session_count" in err


def test_float_count():
    err = validate(_patch(learn_count=1.5))
    assert err and "learn_count" in err


def test_string_count():
    err = validate(_patch(recall_count="ten"))
    assert err and "recall_count" in err


def test_bool_count_rejected():
    # bool is a subclass of int in Python — must be explicitly rejected
    for field in ("learn_count", "recall_count", "session_count"):
        err = validate(_patch(**{field: True}))
        assert err and field in err, f"bool True should be rejected for {field}"
        err = validate(_patch(**{field: False}))
        assert err and field in err, f"bool False should be rejected for {field}"
