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

    def test_call_handles_timeout(self):
        bridge = PlurBridge()
        bridge._binary = "/usr/local/bin/plur"

        with patch("subprocess.run", side_effect=subprocess.TimeoutExpired("plur", 30)):
            with pytest.raises(PlurBridgeError, match="timed out"):
                bridge.call("learn", ["test"])

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
