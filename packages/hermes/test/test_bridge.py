"""Tests for the PLUR CLI bridge."""

import json
import subprocess
import time
import pytest
from unittest.mock import patch, MagicMock
from plur_hermes.bridge import PlurBridge, PlurBridgeError, PlurLockError, PlurNotFoundError


class TestPlurBridge:
    def test_find_binary_on_path(self):
        with patch("shutil.which", return_value="/usr/local/bin/plur"):
            bridge = PlurBridge()
            assert bridge._find_binary() == "/usr/local/bin/plur"

    def test_find_binary_caches_result(self):
        with patch("shutil.which", return_value="/usr/local/bin/plur"):
            bridge = PlurBridge()
            bridge._find_binary()
            result = bridge._find_binary()
            assert result == "/usr/local/bin/plur"

    def test_find_binary_raises_when_not_found(self):
        with patch("shutil.which", return_value=None), \
             patch("os.path.isfile", return_value=False):
            bridge = PlurBridge()
            with pytest.raises(PlurNotFoundError, match="Install"):
                bridge._find_binary()

    def test_call_parses_json_output(self):
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = json.dumps({"id": "ENG-001", "statement": "test"})
        mock_result.stderr = ""

        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        with patch("subprocess.run", return_value=mock_result):
            result = bridge.call("learn", ["test statement"])
            assert result["id"] == "ENG-001"

    def test_call_handles_exit_code_2(self):
        mock_result = MagicMock()
        mock_result.returncode = 2
        mock_result.stdout = json.dumps({"results": [], "count": 0})
        mock_result.stderr = ""

        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        with patch("subprocess.run", return_value=mock_result):
            result = bridge.call("recall", ["nonexistent"])
            assert result["count"] == 0

    def test_call_raises_on_error(self):
        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_result.stdout = ""
        mock_result.stderr = "Error: Engram not found"

        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        with patch("subprocess.run", return_value=mock_result):
            with pytest.raises(PlurBridgeError, match="Engram not found"):
                bridge.call("forget", ["ENG-999"])

    def test_call_timeout_returns_safe_fallback(self):
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        with patch("subprocess.run", side_effect=subprocess.TimeoutExpired("plur", 30)), \
             patch("time.sleep"):
            result = bridge.call("inject", ["test"], retries=0)
        assert result == {"results": [], "count": 0, "injected_ids": []}

    def test_call_timeout_retries_then_falls_back(self):
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        with patch("subprocess.run", side_effect=subprocess.TimeoutExpired("plur", 5)) as mock_run, \
             patch("time.sleep") as mock_sleep:
            result = bridge.call("recall", ["query"], retries=2)

        assert result == {"results": [], "count": 0, "injected_ids": []}
        assert mock_run.call_count == 3
        assert mock_sleep.call_count == 2

    def test_inject_graceful_fallback_on_timeout(self):
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        with patch("subprocess.run", side_effect=subprocess.TimeoutExpired("plur", 5)), \
             patch("time.sleep"):
            result = bridge.inject("some task")
        assert result["count"] == 0
        assert result["injected_ids"] == []

    def test_env_var_timeout_override(self, monkeypatch):
        monkeypatch.setenv("PLUR_BRIDGE_TIMEOUT", "10")
        bridge = PlurBridge()
        assert bridge._timeout == 10

    def test_env_var_inject_timeout_override(self, monkeypatch):
        monkeypatch.setenv("PLUR_BRIDGE_INJECT_TIMEOUT", "2")
        bridge = PlurBridge()
        assert bridge._inject_timeout == 2

    def test_env_var_retry_false_disables_retries(self, monkeypatch):
        monkeypatch.setenv("PLUR_BRIDGE_RETRY", "false")
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        with patch("subprocess.run", side_effect=subprocess.TimeoutExpired("plur", 30)) as mock_run, \
             patch("time.sleep") as mock_sleep:
            result = bridge.call("recall", ["test"], retries=3)

        # retries disabled: only 1 attempt despite retries=3
        assert mock_run.call_count == 1
        assert mock_sleep.call_count == 0
        assert result == {"results": [], "count": 0, "injected_ids": []}

    def test_learn_builds_correct_args(self):
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = json.dumps({"id": "ENG-001"})

        with patch("subprocess.run", return_value=mock_result) as mock_run:
            bridge.learn("test", scope="agent:x", domain="software.testing")
            call_args = mock_run.call_args[0][0]
            assert "learn" in call_args
            assert "--scope" in call_args
            assert "agent:x" in call_args
            assert "--domain" in call_args

    def test_learn_omits_scope_when_none(self):
        """#9: with no scope, --scope is OMITTED so core's unscoped routing
        (auto-route / unscoped_default) applies — the bridge no longer forces
        --scope global and opts out of the 0.10.0 routing behavior."""
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = json.dumps({"id": "ENG-001"})

        with patch("subprocess.run", return_value=mock_result) as mock_run:
            bridge.learn("an unscoped fact")
            call_args = mock_run.call_args[0][0]
            assert "learn" in call_args
            assert "--scope" not in call_args
            assert "global" not in call_args

    def test_learn_preserves_explicit_scope(self):
        """#9: an explicitly passed scope is still honored as-is."""
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = json.dumps({"id": "ENG-001"})

        with patch("subprocess.run", return_value=mock_result) as mock_run:
            bridge.learn("a team fact", scope="group:plur/core")
            call_args = mock_run.call_args[0][0]
            assert "--scope" in call_args
            assert "group:plur/core" in call_args

    def test_learn_forwards_context_fields(self):
        """#8: the bridge forwards every context flag the CLI now consumes
        (rationale/tags/visibility/knowledge-anchors/dual-coding/abstract/
        derived-from), so Hermes-built context is no longer dropped."""
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = json.dumps({"id": "ENG-001"})

        with patch("subprocess.run", return_value=mock_result) as mock_run:
            bridge.learn(
                "rich fact",
                rationale="why it matters",
                tags=["a", "b"],
                visibility="public",
                knowledge_anchors=[{"path": "p.ts"}],
                dual_coding={"example": "e", "analogy": "a"},
                abstract="ABS-1",
                derived_from="ENG-9",
            )
            call_args = mock_run.call_args[0][0]
            for flag in (
                "--rationale", "--tags", "--visibility",
                "--knowledge-anchors", "--dual-coding",
                "--abstract", "--derived-from",
            ):
                assert flag in call_args, f"{flag} missing from CLI args"
            assert "a,b" in call_args  # tags comma-joined

    def test_inject_uses_fast_by_default(self):
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = json.dumps({"count": 0, "directives": "", "constraints": "", "consider": "", "tokens_used": 0})

        with patch("subprocess.run", return_value=mock_result) as mock_run:
            bridge.inject("test task")
            call_args = mock_run.call_args[0][0]
            assert "--fast" in call_args

    def test_learn_dedupes_exact_text_match(self):
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        recall_result = MagicMock()
        recall_result.returncode = 0
        recall_result.stdout = json.dumps({
            "results": [{"id": "ENG-042", "statement": "Use tabs not spaces"}],
            "count": 1,
        })

        with patch("subprocess.run", return_value=recall_result) as mock_run:
            result = bridge.learn("Use tabs not spaces")
            assert result["id"] == "ENG-042"
            assert result["deduplicated"] is True
            assert mock_run.call_count == 1
            assert "recall" in mock_run.call_args_list[0][0][0]

    def test_learn_dedupe_is_case_insensitive_and_trims(self):
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        recall_result = MagicMock()
        recall_result.returncode = 0
        recall_result.stdout = json.dumps({
            "results": [{"id": "ENG-042", "statement": "Use tabs not spaces"}],
        })

        with patch("subprocess.run", return_value=recall_result):
            result = bridge.learn("  use TABS not SPACES  ")
            assert result["deduplicated"] is True
            assert result["id"] == "ENG-042"

    def test_learn_force_bypasses_dedupe(self):
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        learn_result = MagicMock()
        learn_result.returncode = 0
        learn_result.stdout = json.dumps({"id": "ENG-099"})

        with patch("subprocess.run", return_value=learn_result) as mock_run:
            result = bridge.learn("Use tabs not spaces", force=True)
            assert result["id"] == "ENG-099"
            assert "deduplicated" not in result
            assert mock_run.call_count == 1
            assert "learn" in mock_run.call_args_list[0][0][0]

    def test_learn_calls_cli_when_no_duplicate(self):
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        recall_response = MagicMock()
        recall_response.returncode = 0
        recall_response.stdout = json.dumps({"results": [], "count": 0})
        learn_response = MagicMock()
        learn_response.returncode = 0
        learn_response.stdout = json.dumps({"id": "ENG-100"})

        with patch("subprocess.run", side_effect=[recall_response, learn_response]) as mock_run:
            result = bridge.learn("A brand new fact")
            assert result["id"] == "ENG-100"
            assert "deduplicated" not in result
            assert mock_run.call_count == 2

    def test_learn_falls_through_when_recall_fails(self):
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        failed_recall = MagicMock()
        failed_recall.returncode = 1
        failed_recall.stdout = ""
        failed_recall.stderr = "recall blew up"
        learn_response = MagicMock()
        learn_response.returncode = 0
        learn_response.stdout = json.dumps({"id": "ENG-200"})

        with patch("subprocess.run", side_effect=[failed_recall, learn_response]):
            result = bridge.learn("Something to remember")
            assert result["id"] == "ENG-200"
            assert "deduplicated" not in result

    def test_learn_three_identical_calls_yields_one_engram(self):
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        first_recall = MagicMock()
        first_recall.returncode = 0
        first_recall.stdout = json.dumps({"results": [], "count": 0})
        first_learn = MagicMock()
        first_learn.returncode = 0
        first_learn.stdout = json.dumps({"id": "ENG-501", "statement": "Prefer pnpm over npm"})
        second_recall = MagicMock()
        second_recall.returncode = 0
        second_recall.stdout = json.dumps({
            "results": [{"id": "ENG-501", "statement": "Prefer pnpm over npm"}],
        })
        third_recall = MagicMock()
        third_recall.returncode = 0
        third_recall.stdout = json.dumps({
            "results": [{"id": "ENG-501", "statement": "Prefer pnpm over npm"}],
        })

        with patch("subprocess.run", side_effect=[first_recall, first_learn, second_recall, third_recall]):
            r1 = bridge.learn("Prefer pnpm over npm")
            r2 = bridge.learn("Prefer pnpm over npm")
            r3 = bridge.learn("Prefer pnpm over npm")

        assert r1["id"] == "ENG-501"
        assert "deduplicated" not in r1
        assert r2 == {"id": "ENG-501", "statement": "Prefer pnpm over npm", "deduplicated": True}
        assert r3 == {"id": "ENG-501", "statement": "Prefer pnpm over npm", "deduplicated": True}

    def test_learn_inprocess_cache_skips_recall_on_repeat(self):
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        empty_recall = MagicMock()
        empty_recall.returncode = 0
        empty_recall.stdout = json.dumps({"results": [], "count": 0})
        first_learn = MagicMock()
        first_learn.returncode = 0
        first_learn.stdout = json.dumps({"id": "ENG-700", "statement": "Cache me"})

        with patch("subprocess.run", side_effect=[empty_recall, first_learn]) as mock_run:
            r1 = bridge.learn("Cache me")
            assert r1["id"] == "ENG-700"
            assert mock_run.call_count == 2

        with patch("subprocess.run") as mock_run:
            r2 = bridge.learn("Cache me")
            assert r2 == {"id": "ENG-700", "statement": "Cache me", "deduplicated": True}
            assert mock_run.call_count == 0

    def test_learn_inprocess_cache_normalizes_text(self):
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        empty_recall = MagicMock()
        empty_recall.returncode = 0
        empty_recall.stdout = json.dumps({"results": [], "count": 0})
        first_learn = MagicMock()
        first_learn.returncode = 0
        first_learn.stdout = json.dumps({"id": "ENG-701", "statement": "Use TabSize 4"})

        with patch("subprocess.run", side_effect=[empty_recall, first_learn]):
            bridge.learn("Use TabSize 4")

        with patch("subprocess.run") as mock_run:
            r = bridge.learn("  use tabsize 4  ")
            assert r["deduplicated"] is True
            assert r["id"] == "ENG-701"
            assert mock_run.call_count == 0

    def test_learn_recall_dedup_populates_cache(self):
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        recall_hit = MagicMock()
        recall_hit.returncode = 0
        recall_hit.stdout = json.dumps({
            "results": [{"id": "ENG-702", "statement": "Already known"}],
        })

        with patch("subprocess.run", return_value=recall_hit) as mock_run:
            r1 = bridge.learn("Already known")
            assert r1["deduplicated"] is True
            assert mock_run.call_count == 1

        with patch("subprocess.run") as mock_run:
            r2 = bridge.learn("Already known")
            assert r2["deduplicated"] is True
            assert r2["id"] == "ENG-702"
            assert mock_run.call_count == 0

    def test_learn_force_bypasses_cache_read_but_updates_cache(self):
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        empty_recall = MagicMock()
        empty_recall.returncode = 0
        empty_recall.stdout = json.dumps({"results": [], "count": 0})
        first_learn = MagicMock()
        first_learn.returncode = 0
        first_learn.stdout = json.dumps({"id": "ENG-800", "statement": "Twin"})

        with patch("subprocess.run", side_effect=[empty_recall, first_learn]):
            bridge.learn("Twin")

        forced_learn = MagicMock()
        forced_learn.returncode = 0
        forced_learn.stdout = json.dumps({"id": "ENG-801", "statement": "Twin"})

        with patch("subprocess.run", return_value=forced_learn) as mock_run:
            r_forced = bridge.learn("Twin", force=True)
            assert r_forced["id"] == "ENG-801"
            assert "deduplicated" not in r_forced
            assert mock_run.call_count == 1

        with patch("subprocess.run") as mock_run:
            r_after = bridge.learn("Twin")
            assert r_after["id"] == "ENG-801"
            assert r_after["deduplicated"] is True
            assert mock_run.call_count == 0

    def test_learn_cache_size_zero_disables_cache(self):
        bridge = PlurBridge(dedup_cache_size=0)
        bridge._binary = "/usr/local/bin/plur"

        empty_recall = MagicMock()
        empty_recall.returncode = 0
        empty_recall.stdout = json.dumps({"results": [], "count": 0})
        first_learn = MagicMock()
        first_learn.returncode = 0
        first_learn.stdout = json.dumps({"id": "ENG-900", "statement": "no cache"})
        second_recall = MagicMock()
        second_recall.returncode = 0
        second_recall.stdout = json.dumps({
            "results": [{"id": "ENG-900", "statement": "no cache"}],
        })

        with patch("subprocess.run", side_effect=[empty_recall, first_learn, second_recall]) as mock_run:
            r1 = bridge.learn("no cache")
            assert r1["id"] == "ENG-900"
            r2 = bridge.learn("no cache")
            assert r2["deduplicated"] is True
            assert mock_run.call_count == 3

    def test_learn_cache_evicts_oldest_when_full(self):
        bridge = PlurBridge(dedup_cache_size=2)
        bridge._binary = "/usr/local/bin/plur"

        def make_pair(eng_id: str):
            recall = MagicMock()
            recall.returncode = 0
            recall.stdout = json.dumps({"results": [], "count": 0})
            learn = MagicMock()
            learn.returncode = 0
            learn.stdout = json.dumps({"id": eng_id, "statement": eng_id})
            return [recall, learn]

        seq = make_pair("ENG-A") + make_pair("ENG-B") + make_pair("ENG-C")
        with patch("subprocess.run", side_effect=seq):
            bridge.learn("ENG-A")
            bridge.learn("ENG-B")
            bridge.learn("ENG-C")

        assert "eng-a" not in bridge._dedup_cache
        assert "eng-b" in bridge._dedup_cache
        assert "eng-c" in bridge._dedup_cache

    def test_plur_path_passed_to_cli(self):
        bridge = PlurBridge(plur_path="/tmp/test-plur")
        bridge._binary = "/usr/local/bin/plur"

        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = json.dumps({})

        with patch("subprocess.run", return_value=mock_result) as mock_run:
            bridge.status()
            call_args = mock_run.call_args[0][0]
            assert "--path" in call_args
            assert "/tmp/test-plur" in call_args


class TestLockRetry:
    """Lock-failure retry behavior (covers cron-driven contention scenarios).

    The CLI itself retries internally for ~3.1s before reporting "Failed to
    acquire lock". The bridge retries on top of that for sustained contention
    (e.g. a Twitter cron writing while another Hermes session is mid-save).
    """

    @staticmethod
    def _lock_failure_result() -> MagicMock:
        r = MagicMock()
        r.returncode = 1
        r.stdout = json.dumps({"error": "Failed to acquire lock on /tmp/plur/engrams.yaml after 5 retries"})
        r.stderr = ""
        return r

    @staticmethod
    def _success_result() -> MagicMock:
        r = MagicMock()
        r.returncode = 0
        r.stdout = json.dumps({"id": "ENG-001", "statement": "test"})
        r.stderr = ""
        return r

    def test_lock_failure_is_distinct_exception(self):
        """Lock failures raise PlurLockError, not generic PlurBridgeError, after retries."""
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        with patch("subprocess.run", return_value=self._lock_failure_result()), \
             patch("plur_hermes.bridge.time.sleep"):
            with pytest.raises(PlurLockError, match="acquire engram-store lock"):
                bridge.call("learn", ["test"])

    def test_lock_error_is_bridge_error_subclass(self):
        """PlurLockError must be catchable as PlurBridgeError to preserve legacy callers."""
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        with patch("subprocess.run", return_value=self._lock_failure_result()), \
             patch("plur_hermes.bridge.time.sleep"):
            with pytest.raises(PlurBridgeError):  # subclass — must still match
                bridge.call("learn", ["test"])

    def test_call_retries_on_lock_failure_then_succeeds(self):
        """Two consecutive lock failures, then success → no error, success returned."""
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        seq = [self._lock_failure_result(), self._lock_failure_result(), self._success_result()]
        # Pin jitter to 0 so exact delay assertions are deterministic.
        with patch("subprocess.run", side_effect=seq) as mock_run, \
             patch("plur_hermes.bridge.time.sleep") as mock_sleep, \
             patch("plur_hermes.bridge.random.uniform", return_value=0.0):
            result = bridge.call("learn", ["test"])
            assert result["id"] == "ENG-001"
            assert mock_run.call_count == 3
            # Backoff sleeps: 1.0s after first failure, 2.0s after second
            assert mock_sleep.call_count == 2
            assert mock_sleep.call_args_list[0][0][0] == 1.0
            assert mock_sleep.call_args_list[1][0][0] == 2.0

    def test_call_exhausts_retries_then_raises(self):
        """4 consecutive lock failures (initial + 3 retries) → PlurLockError raised."""
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        seq = [self._lock_failure_result()] * 4
        with patch("subprocess.run", side_effect=seq) as mock_run, \
             patch("plur_hermes.bridge.time.sleep"):
            with pytest.raises(PlurLockError):
                bridge.call("learn", ["test"])
            assert mock_run.call_count == 4  # 1 initial + 3 retries

    def test_non_lock_errors_do_not_retry(self):
        """Generic CLI errors (e.g. malformed args) must NOT be retried."""
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        err = MagicMock()
        err.returncode = 1
        err.stdout = ""
        err.stderr = "Error: Engram not found"

        with patch("subprocess.run", return_value=err) as mock_run, \
             patch("plur_hermes.bridge.time.sleep") as mock_sleep:
            with pytest.raises(PlurBridgeError, match="Engram not found"):
                bridge.call("forget", ["ENG-999"])
            assert mock_run.call_count == 1
            assert mock_sleep.call_count == 0

    def test_lock_failure_in_stderr_detected(self):
        """Lock marker should be detected whether it lands in stderr or stdout."""
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        r = MagicMock()
        r.returncode = 1
        r.stdout = ""
        r.stderr = "Error: Failed to acquire lock on /tmp/plur/engrams.yaml after 5 retries"
        seq = [r, self._success_result()]

        with patch("subprocess.run", side_effect=seq), \
             patch("plur_hermes.bridge.time.sleep"):
            result = bridge.call("learn", ["test"])
            assert result["id"] == "ENG-001"

    def test_lock_marker_matches_alternative_phrasings(self):
        """Detection must survive minor upstream wording changes — match any
        'acquire ... lock' phrasing, not just the current exact string."""
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        # Variant 1: "Could not acquire" instead of "Failed to acquire"
        r1 = MagicMock()
        r1.returncode = 1
        r1.stdout = json.dumps({"error": "Could not acquire engram-store lock"})
        r1.stderr = ""

        with patch("subprocess.run", side_effect=[r1, self._success_result()]), \
             patch("plur_hermes.bridge.time.sleep"):
            result = bridge.call("learn", ["test"])
            assert result["id"] == "ENG-001"

        # Variant 2: "Lock acquisition timed out"
        r2 = MagicMock()
        r2.returncode = 1
        r2.stdout = json.dumps({"error": "Lock acquisition timed out"})
        r2.stderr = ""

        with patch("subprocess.run", side_effect=[r2, self._success_result()]), \
             patch("plur_hermes.bridge.time.sleep"):
            result = bridge.call("learn", ["test"])
            assert result["id"] == "ENG-001"

    def test_lock_fail_then_real_error_bubbles_immediately(self):
        """If a lock retry yields a real (non-lock) CLI error on a later
        attempt, that error must surface immediately — no further retries,
        no swallow back to PlurLockError."""
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        non_lock_err = MagicMock()
        non_lock_err.returncode = 1
        non_lock_err.stdout = ""
        non_lock_err.stderr = "Error: Engram schema validation failed"

        with patch("subprocess.run", side_effect=[self._lock_failure_result(), non_lock_err]) as mock_run, \
             patch("plur_hermes.bridge.time.sleep"):
            with pytest.raises(PlurBridgeError, match="schema validation"):
                bridge.call("learn", ["test"])
            # PlurBridgeError is NOT PlurLockError — confirm via type, not match
            try:
                bridge_again = PlurBridge()
                bridge_again._binary = "/usr/local/bin/plur"
                with patch("subprocess.run", side_effect=[self._lock_failure_result(), non_lock_err]):
                    bridge_again.call("learn", ["test"])
            except PlurLockError:
                pytest.fail("Real CLI error was incorrectly classified as PlurLockError")
            except PlurBridgeError:
                pass  # expected
            assert mock_run.call_count == 2  # initial + 1 retry, then non-lock fails fast

    def test_three_retries_then_success(self):
        """Boundary: succeed on the LAST possible retry (3 fails → success on 4th call).
        Off-by-one in the loop would cause this to fail or never succeed."""
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        seq = [self._lock_failure_result()] * 3 + [self._success_result()]
        with patch("subprocess.run", side_effect=seq) as mock_run, \
             patch("plur_hermes.bridge.time.sleep") as mock_sleep, \
             patch("plur_hermes.bridge.random.uniform", return_value=0.0):
            result = bridge.call("learn", ["test"])
            assert result["id"] == "ENG-001"
            assert mock_run.call_count == 4  # 1 initial + 3 retries
            # All three backoff delays consumed (jitter pinned to 0)
            assert [c[0][0] for c in mock_sleep.call_args_list] == [1.0, 2.0, 4.0]

    def test_timeout_triggers_outer_retry_not_lock_retry(self):
        """subprocess.TimeoutExpired is handled by the OUTER timeout-retry
        layer (Miles's, slow 5/15/30s, graceful degradation), NOT the INNER
        lock-retry layer (ours, fast jittered). Lock retries must not fire
        on hangs — those are a different failure mode."""
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        with patch("subprocess.run", side_effect=subprocess.TimeoutExpired("plur", 30)) as mock_run, \
             patch("plur_hermes.bridge.time.sleep") as mock_sleep:
            # All timeouts → graceful safe fallback after outer retries exhaust
            result = bridge.call("learn", ["test"])
            # Outer retry layer: _DEFAULT_RETRIES + 1 attempts = 4 total
            assert mock_run.call_count == 4
            # Sleep called for outer-retry delays (5, 15, 30) — not lock-retry jittered
            sleep_args = [c.args[0] for c in mock_sleep.call_args_list]
            assert sleep_args == [5, 15, 30], \
                f"Expected outer-retry delays [5, 15, 30]; got {sleep_args}"
            # Safe fallback returned (no exception raised)
            assert result == {"results": [], "count": 0, "injected_ids": []}

    def test_jitter_breaks_phase_lock(self):
        """Retry delays must include ±50% jitter so two concurrent bridges
        don't retry in lockstep. Verify random.uniform is invoked per retry."""
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        seq = [self._lock_failure_result()] * 2 + [self._success_result()]
        with patch("subprocess.run", side_effect=seq), \
             patch("plur_hermes.bridge.time.sleep"), \
             patch("plur_hermes.bridge.random.uniform") as mock_uniform:
            mock_uniform.return_value = 0.0
            bridge.call("learn", ["test"])

            # One jitter call per retry (2 retries before success)
            assert mock_uniform.call_count == 2
            # Verify jitter is ±50% of base (so for base=1.0, fuzz=0.5)
            first_call_args = mock_uniform.call_args_list[0][0]
            assert first_call_args == (-0.5, 0.5)  # base 1.0 × ±0.5
            second_call_args = mock_uniform.call_args_list[1][0]
            assert second_call_args == (-1.0, 1.0)  # base 2.0 × ±0.5

    def test_jitter_actually_varies_delays(self):
        """Statistical check: with real random jitter, 100 jitter draws produce
        a non-trivial spread around the base delay (proves jitter is not a stub)."""
        from plur_hermes.bridge import _jittered_delay
        samples = [_jittered_delay(2.0) for _ in range(100)]
        # All within ±50% bounds
        assert all(1.0 <= s <= 3.0 for s in samples)
        # Spread is real — std dev must be > 0 (not all identical)
        spread = max(samples) - min(samples)
        assert spread > 0.5, f"Jitter spread too small: {spread}"

    def test_succeeded_after_retries_emits_info_log(self, caplog):
        """When a retry succeeds, an INFO log should announce the recovery
        so operators can correlate WARNING retry logs with eventual success."""
        import logging
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        seq = [self._lock_failure_result(), self._success_result()]
        with patch("subprocess.run", side_effect=seq), \
             patch("plur_hermes.bridge.time.sleep"), \
             patch("plur_hermes.bridge.random.uniform", return_value=0.0):
            with caplog.at_level(logging.INFO, logger="plur_hermes.bridge"):
                bridge.call("learn", ["test"])

        info_msgs = [r.message for r in caplog.records if r.levelno == logging.INFO]
        assert any("succeeded on retry #1" in m for m in info_msgs), \
            f"Expected 'succeeded on retry #N' INFO log; got: {info_msgs}"

    def test_no_success_log_on_first_attempt(self, caplog):
        """A successful first attempt must NOT emit the recovery INFO log —
        that would create noise on every healthy call."""
        import logging
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        with patch("subprocess.run", return_value=self._success_result()), \
             patch("plur_hermes.bridge.time.sleep"):
            with caplog.at_level(logging.INFO, logger="plur_hermes.bridge"):
                bridge.call("learn", ["test"])

        info_msgs = [r.message for r in caplog.records if r.levelno == logging.INFO]
        assert not any("succeeded on retry" in m for m in info_msgs), \
            f"Unexpected success log on first attempt: {info_msgs}"

    def test_error_message_unwraps_json_envelope(self):
        """When the CLI emits {'error': '...'} on stdout (the --json path),
        the resulting exception message must contain the inner error text,
        not the raw JSON wrapper."""
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        non_lock_err = MagicMock()
        non_lock_err.returncode = 1
        non_lock_err.stdout = json.dumps({"error": "Engram schema validation failed: bad tag"})
        non_lock_err.stderr = ""

        with patch("subprocess.run", return_value=non_lock_err):
            with pytest.raises(PlurBridgeError) as exc_info:
                bridge.call("learn", ["bad"])

        msg = str(exc_info.value)
        assert "Engram schema validation failed: bad tag" in msg
        # Raw JSON envelope must NOT appear in the user-facing message
        assert '"error":' not in msg
        assert "{" not in msg

    def test_lock_error_message_unwraps_json_envelope(self):
        """Same unwrap for lock errors — the message should be the clean
        underlying text, not the JSON wrapper."""
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        with patch("subprocess.run", return_value=self._lock_failure_result()), \
             patch("plur_hermes.bridge.time.sleep"), \
             patch("plur_hermes.bridge.random.uniform", return_value=0.0):
            with pytest.raises(PlurLockError) as exc_info:
                bridge.call("learn", ["test"])

        msg = str(exc_info.value)
        assert "Failed to acquire lock" in msg
        assert '"error":' not in msg  # JSON envelope stripped

    def test_retry_logic_survives_python_optimize_flag(self):
        """The retry-exhaustion raise must NOT depend on `assert` (stripped
        under python -O). Scan the bytecode for an `ASSERT` opcode — that's
        the actual fingerprint of an `assert` statement, free from comment
        false-positives."""
        import dis
        from plur_hermes import bridge as bridge_module
        ops = [i.opname for i in dis.get_instructions(bridge_module.PlurBridge.call)]
        # Python emits LOAD_ASSERTION_ERROR / RAISE_VARARGS pair for asserts.
        # Either opcode appearing inside this method means an assert is present.
        assert "LOAD_ASSERTION_ERROR" not in ops, \
            "PlurBridge.call has an `assert` statement; will be stripped under -O"

    def test_non_lock_error_after_lock_failure_uses_unwrapped_message(self):
        """Mixed scenario: lock fail → retry → real CLI error. The real error's
        message should be cleanly extracted, not concatenated with prior state."""
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        non_lock_err = MagicMock()
        non_lock_err.returncode = 1
        non_lock_err.stdout = json.dumps({"error": "Engram ENG-999 not found"})
        non_lock_err.stderr = ""

        with patch("subprocess.run", side_effect=[self._lock_failure_result(), non_lock_err]), \
             patch("plur_hermes.bridge.time.sleep"), \
             patch("plur_hermes.bridge.random.uniform", return_value=0.0):
            with pytest.raises(PlurBridgeError, match="Engram ENG-999 not found") as exc_info:
                bridge.call("learn", ["test"])
            # Must not be classified as PlurLockError (the real error is not a lock issue)
            assert not isinstance(exc_info.value, PlurLockError)

    def test_stderr_npm_noise_does_not_hide_stdout_json_error(self):
        """Real-world: npm prints deprecation warnings to stderr, the actual
        CLI error lands as --json on stdout. We must extract the stdout JSON
        error, not return the stderr noise."""
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        noisy = MagicMock()
        noisy.returncode = 1
        noisy.stderr = "npm warn deprecated some-pkg@1.0.0: use new-pkg instead\n"
        noisy.stdout = json.dumps({"error": "Engram validation failed: bad tag"})

        with patch("subprocess.run", return_value=noisy):
            with pytest.raises(PlurBridgeError) as exc_info:
                bridge.call("learn", ["test"])

        msg = str(exc_info.value)
        assert "Engram validation failed: bad tag" in msg, \
            f"npm noise hid the real CLI error: {msg}"
        assert "npm warn" not in msg, \
            f"npm noise leaked into user-facing error: {msg}"

    def test_lock_error_unwraps_under_stderr_noise(self):
        """Same npm-noise scenario but with the inner error being a lock failure.
        Must (a) classify as PlurLockError, (b) message must NOT contain npm noise."""
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        noisy = MagicMock()
        noisy.returncode = 1
        noisy.stderr = "npm warn config global is deprecated\n"
        noisy.stdout = json.dumps({"error": "Failed to acquire lock on /tmp/engrams.yaml after 5 retries"})

        with patch("subprocess.run", return_value=noisy), \
             patch("plur_hermes.bridge.time.sleep"), \
             patch("plur_hermes.bridge.random.uniform", return_value=0.0):
            with pytest.raises(PlurLockError) as exc_info:
                bridge.call("learn", ["test"])

        msg = str(exc_info.value)
        assert "Failed to acquire lock" in msg
        assert "npm warn" not in msg

    def test_extract_error_falls_back_to_stderr_when_stdout_empty(self):
        """When stdout has no JSON error, stderr should be used as the message."""
        from plur_hermes.bridge import _extract_cli_error_message
        assert _extract_cli_error_message("Actual error text", "") == "Actual error text"
        assert _extract_cli_error_message("Actual error text", None) == "Actual error text"

    def test_extract_error_falls_back_to_stderr_when_stdout_json_lacks_error_key(self):
        """If stdout is JSON but has no 'error' key, fall through to stderr."""
        from plur_hermes.bridge import _extract_cli_error_message
        # stdout has {"status": "ok"} — no error key. stderr has real text.
        result = _extract_cli_error_message("stderr text", '{"status": "ok"}')
        assert result == "stderr text", \
            f"Expected stderr fallback when stdout JSON has no 'error' key, got: {result}"

    def test_extract_error_handles_malformed_json(self):
        """Malformed JSON on stdout should fall through to stderr."""
        from plur_hermes.bridge import _extract_cli_error_message
        result = _extract_cli_error_message("real error", "{not valid json")
        assert result == "real error"

    def test_extract_error_empty_inputs_returns_empty(self):
        """Both fields empty → empty string, no exception."""
        from plur_hermes.bridge import _extract_cli_error_message
        assert _extract_cli_error_message("", "") == ""
        assert _extract_cli_error_message(None, None) == ""

    def test_extract_error_null_error_value_does_not_fall_back_to_stderr(self):
        """{"error": null} from CLI is the authoritative signal — don't let
        stderr noise (npm warnings) leak in via fallthrough."""
        from plur_hermes.bridge import _extract_cli_error_message
        result = _extract_cli_error_message(
            "npm warn deprecated some-pkg",
            json.dumps({"error": None}),
        )
        assert result == "", f"Expected '' for null error; got: {result!r}"
        assert "npm warn" not in result

    def test_extract_error_empty_string_error_value_does_not_fall_back(self):
        """{"error": ""} same treatment as null — authoritative empty signal."""
        from plur_hermes.bridge import _extract_cli_error_message
        result = _extract_cli_error_message(
            "DeprecationWarning: ...",
            json.dumps({"error": ""}),
        )
        assert result == "", f"Expected '' for empty error; got: {result!r}"
        assert "Deprecation" not in result

    def test_extract_error_empty_object_falls_back_to_stderr(self):
        """{} has no 'error' key at all — that's NOT an authoritative signal,
        so fall through to stderr."""
        from plur_hermes.bridge import _extract_cli_error_message
        result = _extract_cli_error_message("real stderr error", "{}")
        assert result == "real stderr error"

    def test_extract_error_non_object_json_falls_through(self):
        """A JSON array on stdout (not an object) — startswith('{') is False,
        so no parse is attempted; falls to stderr."""
        from plur_hermes.bridge import _extract_cli_error_message
        result = _extract_cli_error_message("stderr msg", '[{"error": "bad"}]')
        assert result == "stderr msg"


class TestDedupTtlCache:
    """Issue #120 (in-process half) — TTL on the dedup cache.

    The #119 v2 LRU cache made in-session repeat learn() calls skip the
    subprocess entirely, but entries lived for the whole process lifetime.
    In a long-lived Hermes process spanning many logical sessions that means
    a `forget` (or edit) from another session is never observed: the bridge
    keeps serving `deduplicated: true` with a dangling engram id forever.

    The TTL bounds that staleness: cache hits stay sub-millisecond (repeat
    statements << the 50 ms AC), and every entry is revalidated against the
    store via the recall path after `dedup_cache_ttl` seconds. The deadline
    is anchored at WRITE time — reads never extend it — so even a hot
    statement revalidates every TTL seconds.

    The true cross-session cold path (< 50 ms with NO in-process cache hit)
    needs the `plur serve` daemon and stays open on #120.
    """

    @staticmethod
    def _mock_json(payload: dict) -> MagicMock:
        m = MagicMock()
        m.returncode = 0
        m.stdout = json.dumps(payload)
        m.stderr = ""
        return m

    def _learned_bridge(self, ttl: float, statement: str = "Prefer pnpm over npm",
                        engram_id: str = "ENG-120") -> PlurBridge:
        """Bridge with `statement` already learned (cache warm), subprocess mocked."""
        bridge = PlurBridge(dedup_cache_ttl=ttl)
        bridge._binary = "/usr/local/bin/plur"
        empty_recall = self._mock_json({"results": [], "count": 0})
        learn_ok = self._mock_json({"id": engram_id, "statement": statement})
        with patch("subprocess.run", side_effect=[empty_recall, learn_ok]):
            r = bridge.learn(statement)
            assert r["id"] == engram_id
        return bridge

    def test_cache_hit_within_ttl_skips_subprocess(self):
        bridge = self._learned_bridge(ttl=60.0)
        with patch("subprocess.run") as mock_run:
            r = bridge.learn("Prefer pnpm over npm")
            assert r == {"id": "ENG-120", "statement": "Prefer pnpm over npm",
                         "deduplicated": True}
            assert mock_run.call_count == 0

    def test_cache_entry_expires_after_ttl_and_revalidates(self):
        bridge = self._learned_bridge(ttl=0.05)
        time.sleep(0.15)
        # Entry expired → bridge must revalidate via recall. Store still has
        # the engram, so the result is a dedup hit sourced from the store.
        recall_hit = self._mock_json({
            "results": [{"id": "ENG-120", "statement": "Prefer pnpm over npm"}],
        })
        with patch("subprocess.run", side_effect=[recall_hit]) as mock_run:
            r = bridge.learn("Prefer pnpm over npm")
            assert r == {"id": "ENG-120", "statement": "Prefer pnpm over npm",
                         "deduplicated": True}
            assert mock_run.call_count == 1  # exactly one recall, no insert

    def test_revalidation_rearms_ttl(self):
        bridge = self._learned_bridge(ttl=0.05)
        time.sleep(0.15)
        recall_hit = self._mock_json({
            "results": [{"id": "ENG-120", "statement": "Prefer pnpm over npm"}],
        })
        with patch("subprocess.run", side_effect=[recall_hit]):
            bridge.learn("Prefer pnpm over npm")
        # Revalidation re-armed the entry — next call is a pure cache hit.
        with patch("subprocess.run") as mock_run:
            r = bridge.learn("Prefer pnpm over npm")
            assert r["deduplicated"] is True
            assert mock_run.call_count == 0

    def test_stale_entry_dropped_when_store_changed(self):
        """Cross-session correctness: engram forgotten elsewhere → after TTL
        the bridge must NOT serve the dangling id; it re-learns."""
        bridge = self._learned_bridge(ttl=0.05)
        time.sleep(0.15)
        empty_recall = self._mock_json({"results": [], "count": 0})
        relearn = self._mock_json({"id": "ENG-121", "statement": "Prefer pnpm over npm"})
        with patch("subprocess.run", side_effect=[empty_recall, relearn]) as mock_run:
            r = bridge.learn("Prefer pnpm over npm")
            assert r["id"] == "ENG-121"
            assert "deduplicated" not in r
            assert mock_run.call_count == 2  # recall miss + insert

    def test_read_does_not_extend_deadline(self):
        """Staleness bound is write-anchored: hot statements still revalidate
        every TTL seconds even when hit continuously."""
        bridge = self._learned_bridge(ttl=0.3)
        time.sleep(0.15)
        with patch("subprocess.run") as mock_run:
            assert bridge.learn("Prefer pnpm over npm")["deduplicated"] is True
            assert mock_run.call_count == 0  # mid-TTL hit
        time.sleep(0.25)  # now past the original write deadline
        recall_hit = self._mock_json({
            "results": [{"id": "ENG-120", "statement": "Prefer pnpm over npm"}],
        })
        with patch("subprocess.run", side_effect=[recall_hit]) as mock_run:
            assert bridge.learn("Prefer pnpm over npm")["deduplicated"] is True
            assert mock_run.call_count == 1  # the mid-TTL hit did not re-arm

    def test_ttl_zero_disables_expiry(self):
        """ttl <= 0 restores the pre-TTL infinite-lifetime behavior."""
        bridge = self._learned_bridge(ttl=0)
        time.sleep(0.1)
        with patch("subprocess.run") as mock_run:
            r = bridge.learn("Prefer pnpm over npm")
            assert r["deduplicated"] is True
            assert mock_run.call_count == 0

    def test_ttl_env_override(self, monkeypatch):
        monkeypatch.setenv("PLUR_BRIDGE_DEDUP_TTL", "123.5")
        bridge = PlurBridge()
        assert bridge._dedup_cache_ttl == 123.5

    def test_ttl_constructor_beats_env(self, monkeypatch):
        monkeypatch.setenv("PLUR_BRIDGE_DEDUP_TTL", "123.5")
        bridge = PlurBridge(dedup_cache_ttl=7.0)
        assert bridge._dedup_cache_ttl == 7.0

    def test_force_learn_rearms_expired_entry(self):
        """force=True bypasses cache reads but its result re-populates the
        cache with a fresh deadline (same contract as #119, now with TTL)."""
        bridge = self._learned_bridge(ttl=0.05)
        time.sleep(0.15)
        forced = self._mock_json({"id": "ENG-122", "statement": "Prefer pnpm over npm"})
        with patch("subprocess.run", side_effect=[forced]) as mock_run:
            r = bridge.learn("Prefer pnpm over npm", force=True)
            assert r["id"] == "ENG-122"
            assert mock_run.call_count == 1  # no recall on force
        with patch("subprocess.run") as mock_run:
            r = bridge.learn("Prefer pnpm over npm")
            assert r == {"id": "ENG-122", "statement": "Prefer pnpm over npm",
                         "deduplicated": True}
            assert mock_run.call_count == 0

    def test_lru_eviction_still_works_with_ttl(self):
        bridge = PlurBridge(dedup_cache_size=2, dedup_cache_ttl=60.0)
        bridge._binary = "/usr/local/bin/plur"
        empty = self._mock_json({"results": [], "count": 0})
        for i, stmt in enumerate(("eng-a", "eng-b", "eng-c")):
            learn_ok = self._mock_json({"id": f"ENG-{i}", "statement": stmt})
            with patch("subprocess.run", side_effect=[empty, learn_ok]):
                bridge.learn(stmt)
        assert "eng-a" not in bridge._dedup_cache
        assert "eng-b" in bridge._dedup_cache
        assert "eng-c" in bridge._dedup_cache

    def test_benchmark_repeat_learn_median_under_50ms(self, capsys):
        """Micro-benchmark for the #120 in-process AC reading: repeat learn()
        of a statement already in cache must complete in < 50 ms median.

        subprocess.run is patched to fail loudly, so the timed loop measures
        the true production cache-hit path — which by construction performs
        zero subprocess work. Numbers are printed for the PR body.
        """
        bridge = self._learned_bridge(ttl=300.0)
        n = 1000
        samples: list[float] = []
        with patch("subprocess.run",
                   side_effect=AssertionError("subprocess on cache-hit path")):
            for _ in range(n):
                t0 = time.perf_counter()
                r = bridge.learn("Prefer pnpm over npm")
                samples.append(time.perf_counter() - t0)
                assert r["deduplicated"] is True
        samples.sort()
        median = samples[n // 2]
        p95 = samples[int(n * 0.95)]
        worst = samples[-1]
        with capsys.disabled():
            print(f"\n[bench #120] repeat learn() cache hit, n={n}: "
                  f"median={median * 1000:.4f}ms p95={p95 * 1000:.4f}ms "
                  f"max={worst * 1000:.4f}ms")
        assert median < 0.050, f"median {median * 1000:.3f}ms >= 50ms"
        assert p95 < 0.050, f"p95 {p95 * 1000:.3f}ms >= 50ms"
