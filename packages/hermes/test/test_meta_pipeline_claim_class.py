"""Security audit 2026-11-06: Hermes' meta pipeline saves model-formulated
statements through bridge.learn at scope global. They must be marked
claim_class 'inferred' so core's prompt-injection gate for inferred text
applies — whenever the bridge's learn() accepts that parameter. A bridge
without it keeps working unchanged.

Runs under pytest, or standalone: python3 -I test/test_meta_pipeline_claim_class.py
"""

import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from plur_hermes.meta_pipeline import MetaPipeline, MetaPipelineState  # noqa: E402


class _BridgeWithClaimClass:
    def __init__(self):
        self.calls = []

    def learn(self, statement, scope=None, type="behavioral", domain=None,
              claim_class=None, force=False):
        self.calls.append({"statement": statement, "scope": scope, "claim_class": claim_class})
        return {"id": "ENG-DUMMY"}


class _BridgeWithoutClaimClass:
    def __init__(self):
        self.calls = []

    def learn(self, statement, scope=None, type="behavioral", domain=None, force=False):
        self.calls.append({"statement": statement, "scope": scope})
        return {"id": "ENG-DUMMY"}


def _run(bridge):
    tmp = tempfile.mkdtemp()
    try:
        pipeline = MetaPipeline(bridge, plur_path=tmp)
        state = MetaPipelineState(session_id="sess-dummy")
        return pipeline._save_and_finalize(
            state, [{"statement": "Dummy meta principle", "domain": "meta"}], retry_round=False)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_meta_saved_as_inferred_when_bridge_supports_it():
    bridge = _BridgeWithClaimClass()
    result = _run(bridge)
    assert result["saved"] == 1
    assert bridge.calls and bridge.calls[0]["claim_class"] == "inferred", bridge.calls


def test_bridge_without_claim_class_still_saves():
    bridge = _BridgeWithoutClaimClass()
    result = _run(bridge)
    assert result["saved"] == 1, result
    assert len(bridge.calls) == 1


if __name__ == "__main__":
    failures = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except AssertionError as e:
                failures += 1
                print(f"FAIL {name}: {e}")
    print(f"{failures} failed")
    sys.exit(1 if failures else 0)
