"""Tests for the PLUR CLI bridge."""

import json
import subprocess
import pytest
from unittest.mock import patch, MagicMock
from plur_hermes.bridge import PlurBridge, PlurBridgeError, PlurNotFoundError


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
