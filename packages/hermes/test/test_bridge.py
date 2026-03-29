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
