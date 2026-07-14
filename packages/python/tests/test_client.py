"""Tests for the plur-ai client.

The roundtrip tests run against a real PLUR CLI. They are skipped unless one is
resolvable — set ``PLUR_CLI`` (e.g. ``node .../packages/cli/dist/index.js``) or
have ``plur`` on ``PATH``. The not-installed test runs everywhere.
"""
from __future__ import annotations

import os
import re
import shutil
import tempfile
from pathlib import Path

import pytest

from plur_ai import Plur, PlurError, PlurNotInstalledError
from plur_ai.bridge import _NPX_CLI_VERSION


def _cli_available() -> bool:
    return bool(os.environ.get("PLUR_CLI") or shutil.which("plur"))


requires_cli = pytest.mark.skipif(
    not _cli_available(),
    reason="PLUR CLI not available (set PLUR_CLI or install @plur-ai/cli)",
)


@requires_cli
def test_learn_status_roundtrip():
    # Was ``test_learn_recall_status_roundtrip``. The recall assertion that used
    # to live here — ``recall("API style")`` finding "REST" — was VACUOUS: "API"
    # lexically matches the seeded "api-service", so it passed under BM25-only or
    # hybrid alike and proved nothing about which search leg ran. That check now
    # lives, honestly, in ``test_recall_finds_semantic_match`` (a query with no
    # lexical overlap). This test keeps only the learn + status legs, which are
    # genuinely green.
    d = tempfile.mkdtemp(prefix="plur-pytest-")
    try:
        plur = Plur(path=d)
        eng = plur.learn(
            "api-service uses REST not GraphQL",
            type="architectural",
            domain="dev/arch",
        )
        assert eng["id"].startswith("ENG-")

        st = plur.status()
        assert st["engram_count"] >= 1
        assert st["storage_root"] == d
    finally:
        shutil.rmtree(d, ignore_errors=True)


# BUG-ENCODING (#495): recall() shells out with ``--fast`` (BM25-only) AND the
# bridge raises PlurError on the CLI's exit-2 empty-result signal. Both faults
# converge here: a purely-semantic query (no lexical/stem overlap with the
# seeded engram) is unmatchable by BM25, so --fast returns zero results, the CLI
# exits 2, and recall() raises instead of surfacing the semantically-relevant
# engram. Verified live: `recall --fast "zero-downtime shipping approach"` on a
# store holding the blue-green engram → {"results":[],"count":0} exit 2, whereas
# hybrid returns the engram. This is the honest replacement for the old vacuous
# lexical-overlap assertion. strict=True: when recall() is fixed to run hybrid
# (and not raise on empty) this XPASSes and forces the xfail to be removed.
@requires_cli
@pytest.mark.xfail(
    strict=True,
    reason="recall() uses --fast (BM25-only) and raises on the resulting "
    "exit-2 empty result — it cannot make a purely-semantic match; see #495",
)
def test_recall_finds_semantic_match():
    d = tempfile.mkdtemp(prefix="plur-pytest-")
    try:
        plur = Plur(path=d)
        plur.learn("deploy with blue-green never in-place", type="architectural")
        # No lexical/stem overlap with the engram — only semantic/hybrid search
        # can connect "zero-downtime shipping approach" to "blue-green deploy".
        results = plur.recall("zero-downtime shipping approach", limit=5)
        assert any("blue-green" in r["statement"] for r in results)
    finally:
        shutil.rmtree(d, ignore_errors=True)


# BUG-ENCODING (#495): the CLI exits 2 on a zero-result recall (recall.ts:32)
# and the bridge's run_json treats ANY nonzero exit as an error (bridge.py:78),
# so a normal "no match" RAISES PlurError instead of returning []. Hermes already
# handles exit 2 as an empty result (plur_hermes/bridge.py:320); the Python SDK
# does not. strict=True: once bridge.py maps exit 2 → [] this XPASSes and forces
# the xfail to be removed.
@requires_cli
@pytest.mark.xfail(
    strict=True,
    reason="recall() raises PlurError on the CLI's exit-2 empty-result signal "
    "instead of returning []; see #495",
)
def test_recall_empty_returns_list():
    d = tempfile.mkdtemp(prefix="plur-pytest-")
    try:
        plur = Plur(path=d)
        plur.learn("deploy with blue-green never in-place", type="architectural")
        # Nonsense query guaranteed to match nothing → CLI returns
        # {"results":[],"count":0} with exit code 2.
        results = plur.recall("zzzqqq nonexistent xyzzy vw-nomatch", limit=5)
        assert results == []
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


@requires_cli
def test_recall_hybrid_returns_results():
    # Honest hybrid test: the query shares NO lexical/stem overlap with the
    # seeded engram, so only the embedding/hybrid leg can connect them. Under
    # BM25-only this query returns zero results (verified: `recall --fast
    # "zero-downtime shipping approach"` → exit 2, empty), so if embeddings were
    # ever dropped from recall_hybrid this assertion would fail (or raise) —
    # which is exactly what makes it non-vacuous. recall_hybrid() does NOT pass
    # --fast, so it genuinely runs hybrid and this is green today.
    d = tempfile.mkdtemp(prefix="plur-pytest-")
    try:
        plur = Plur(path=d)
        plur.learn("deploy with blue-green never in-place", type="architectural")
        results = plur.recall_hybrid("zero-downtime shipping approach", limit=5)
        assert isinstance(results, list)
        assert any("blue-green" in r["statement"] for r in results)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_missing_cli_raises(monkeypatch):
    monkeypatch.delenv("PLUR_CLI", raising=False)
    monkeypatch.setattr("plur_ai.bridge.shutil.which", lambda _name: None)
    from plur_ai.bridge import run_json

    with pytest.raises(PlurNotInstalledError):
        run_json(["status"])


def _major_minor(version: str) -> tuple[int, int]:
    parts = version.split(".")
    return (int(parts[0]), int(parts[1]))


def test_npx_cli_version_pin_tracks_pyproject():
    """Coupling guard for the npx-fallback CLI pin.

    bridge.py's comment claims ``release tooling bumps this`` — but nothing in
    this package enforces it (unlike hermes, which has
    ``scripts/check_version_sync.py``). That comment is FALSE as written: the
    pin is bumped by hand, if at all. This test is the only guard: the pinned
    ``@plur-ai/cli`` must be on the SDK's own major line and at least as new
    (major.minor) as the SDK package version — otherwise the npx fallback would
    silently install a CLI predating this SDK, exactly the drift the comment
    pretends is handled. (Code-fix TODO: correct the false comment in bridge.py.)
    """
    pyproject = Path(__file__).resolve().parent.parent / "pyproject.toml"
    m = re.search(r'^version\s*=\s*"([^"]+)"', pyproject.read_text(), re.MULTILINE)
    assert m, "could not find [project] version in pyproject.toml"
    sdk_version = m.group(1)
    sdk = _major_minor(sdk_version)
    pin = _major_minor(_NPX_CLI_VERSION)

    assert pin[0] == sdk[0], (
        f"npx CLI pin {_NPX_CLI_VERSION} is on a different major line than the "
        f"SDK {sdk_version} — the pin is stale or mismatched"
    )
    assert pin >= sdk, (
        f"npx CLI pin {_NPX_CLI_VERSION} is older than the SDK's own version "
        f"{sdk_version} — the fallback would install a CLI predating this SDK"
    )
