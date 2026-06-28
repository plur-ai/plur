"""Tests for the plur-ai client.

The roundtrip tests run against a real PLUR CLI. They are skipped unless one is
resolvable — set ``PLUR_CLI`` (e.g. ``node .../packages/cli/dist/index.js``) or
have ``plur`` on ``PATH``. The not-installed test runs everywhere.
"""
from __future__ import annotations

import os
import shutil
import tempfile

import pytest

from plur_ai import Plur, PlurNotInstalledError


def _cli_available() -> bool:
    return bool(os.environ.get("PLUR_CLI") or shutil.which("plur"))


requires_cli = pytest.mark.skipif(
    not _cli_available(),
    reason="PLUR CLI not available (set PLUR_CLI or install @plur-ai/cli)",
)


@requires_cli
def test_learn_recall_status_roundtrip():
    d = tempfile.mkdtemp(prefix="plur-pytest-")
    try:
        plur = Plur(path=d)
        eng = plur.learn(
            "api-service uses REST not GraphQL",
            type="architectural",
            domain="dev/arch",
        )
        assert eng["id"].startswith("ENG-")

        results = plur.recall("API style", limit=5)
        assert any("REST" in r["statement"] for r in results)

        st = plur.status()
        assert st["engram_count"] >= 1
        assert st["storage_root"] == d
    finally:
        shutil.rmtree(d, ignore_errors=True)


@requires_cli
def test_inject_returns_sections():
    d = tempfile.mkdtemp(prefix="plur-pytest-")
    try:
        plur = Plur(path=d)
        plur.learn("deploy with blue-green never in-place", type="architectural")
        out = plur.inject("how should we deploy", budget=2000)
        assert "count" in out
        # the engram should surface in one of the three sections
        blob = out["directives"] + out["constraints"] + out["consider"]
        assert "blue-green" in blob
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_missing_cli_raises(monkeypatch):
    monkeypatch.delenv("PLUR_CLI", raising=False)
    monkeypatch.setattr("plur_ai.bridge.shutil.which", lambda _name: None)
    from plur_ai.bridge import run_json

    with pytest.raises(PlurNotInstalledError):
        run_json(["status"])
