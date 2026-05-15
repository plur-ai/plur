"""Tests for injection feedback in post_llm_call and signal detection helpers."""

import os
import pytest
from unittest.mock import MagicMock, patch
from plur_hermes import _detect_injection_signal, _get_trigrams, _FEEDBACK_MIN_CONFIDENCE


class TestGetTrigrams:
    def test_standard_trigrams(self):
        tris = _get_trigrams("always use pnpm not npm")
        assert "always use pnpm" in tris
        assert "use pnpm not" in tris
        assert "pnpm not npm" in tris

    def test_short_text_returns_words(self):
        assert _get_trigrams("hello") == {"hello"}
        assert _get_trigrams("hello world") == {"hello", "world"}

    def test_empty_string(self):
        assert _get_trigrams("") == set()


class TestDetectInjectionSignal:
    def test_positive_verbatim_match(self):
        signal, confidence = _detect_injection_signal(
            "always use pnpm not npm",
            "Sure, I'll keep in mind to always use pnpm not npm for this project."
        )
        assert signal == "positive"
        assert confidence >= _FEEDBACK_MIN_CONFIDENCE

    def test_positive_trigram_overlap(self):
        engram = "prefer TypeScript strict mode for all new files"
        response = "I'll use TypeScript strict mode for all new files as requested."
        signal, confidence = _detect_injection_signal(engram, response)
        assert signal == "positive"
        assert confidence >= _FEEDBACK_MIN_CONFIDENCE

    def test_negative_correction_marker(self):
        engram = "always commit with --no-verify to skip hooks"
        response = "Actually, you should never skip hooks with --no-verify — they catch real bugs."
        signal, confidence = _detect_injection_signal(engram, response)
        assert signal == "negative"
        assert confidence >= _FEEDBACK_MIN_CONFIDENCE

    def test_no_signal_unrelated_response(self):
        engram = "use snake_case for Python variables"
        response = "The weather today is sunny with a high of 22 degrees."
        signal, confidence = _detect_injection_signal(engram, response)
        assert signal is None
        assert confidence < _FEEDBACK_MIN_CONFIDENCE

    def test_empty_engram_returns_no_signal(self):
        signal, confidence = _detect_injection_signal("", "some response text")
        assert signal is None

    def test_case_insensitive_matching(self):
        signal, confidence = _detect_injection_signal(
            "Use PNPM not NPM",
            "As a reminder I should use pnpm not npm."
        )
        assert signal == "positive"
        assert confidence >= _FEEDBACK_MIN_CONFIDENCE

    def test_negative_no_engram_topic_nearby(self):
        engram = "deploy with rsync to production servers"
        response = "Actually, that's wrong about completely unrelated topic X."
        signal, _ = _detect_injection_signal(engram, response)
        assert signal is None

    def test_multi_engram_mixed_signals(self):
        # Positive match
        s1, c1 = _detect_injection_signal(
            "always use pnpm not npm",
            "I'll always use pnpm not npm. Actually, the deploy path is wrong."
        )
        assert s1 == "positive"

        # Negative match — response contradicts engram without repeating it verbatim
        s2, c2 = _detect_injection_signal(
            "always commit with --no-verify to skip hooks",
            "I'll always use pnpm not npm. Actually, skipping hooks with --no-verify is dangerous."
        )
        assert s2 == "negative"

        # No signal
        s3, c3 = _detect_injection_signal(
            "use snake_case for Python variables",
            "I'll always use pnpm not npm. Actually, the deploy path is wrong."
        )
        assert s3 is None


class TestPostLlmCallFeedback:
    """Integration-style tests for the feedback path via mock bridge."""

    def _make_ctx(self):
        class Ctx:
            def __init__(self):
                self.hooks = {}
                self.tools = {}

            def register_hook(self, name, fn):
                self.hooks[name] = fn

            def register_tool(self, name, toolset, schema, handler):
                self.tools[name] = handler

        return Ctx()

    def _make_bridge(self):
        bridge = MagicMock()
        bridge._plur_path = None
        bridge.status.return_value = {"engram_count": 10}
        bridge.inject.return_value = {
            "count": 1,
            "injected_ids": ["ENG-001"],
            "results": [{"id": "ENG-001", "statement": "always use pnpm not npm"}],
            "directives": "always use pnpm not npm",
        }
        bridge.learn.return_value = {"id": "ENG-NEW"}
        bridge.feedback.return_value = {"ok": True}
        return bridge

    @patch.dict(os.environ, {"PLUR_INJECTION_FEEDBACK": "true"})
    def test_positive_feedback_sent(self):
        import plur_hermes
        bridge = self._make_bridge()
        with patch("plur_hermes.PlurBridge", return_value=bridge):
            ctx = self._make_ctx()
            plur_hermes.register(ctx)
            plur_hermes._session_state["s1"] = {
                "count": 0, "started": 0,
                "injected_ids": ["ENG-001"],
                "injected_engrams": [{"id": "ENG-001", "statement": "always use pnpm not npm"}],
            }

            ctx.hooks["post_llm_call"](
                "s1",
                "Sure, I'll use always use pnpm not npm for this project."
            )

            bridge.feedback.assert_called_once()
            batch = bridge.feedback.call_args[1]["batch"]
            assert ("ENG-001", "positive") in batch

    @patch.dict(os.environ, {"PLUR_INJECTION_FEEDBACK": "false"})
    def test_feedback_disabled_by_env(self):
        import plur_hermes
        bridge = self._make_bridge()
        with patch("plur_hermes.PlurBridge", return_value=bridge):
            ctx = self._make_ctx()
            plur_hermes.register(ctx)
            plur_hermes._session_state["s2"] = {
                "count": 0, "started": 0,
                "injected_ids": ["ENG-001"],
                "injected_engrams": [{"id": "ENG-001", "statement": "always use pnpm not npm"}],
            }

            ctx.hooks["post_llm_call"](
                "s2",
                "I'll use always use pnpm not npm for this project."
            )

            bridge.feedback.assert_not_called()

    @patch.dict(os.environ, {"PLUR_INJECTION_FEEDBACK": "true"})
    def test_no_feedback_on_unrelated_response(self):
        import plur_hermes
        bridge = self._make_bridge()
        with patch("plur_hermes.PlurBridge", return_value=bridge):
            ctx = self._make_ctx()
            plur_hermes.register(ctx)
            plur_hermes._session_state["s3"] = {
                "count": 0, "started": 0,
                "injected_ids": ["ENG-001"],
                "injected_engrams": [{"id": "ENG-001", "statement": "always use pnpm not npm"}],
            }

            ctx.hooks["post_llm_call"]("s3", "The sky is blue and the sun is bright today.")

            bridge.feedback.assert_not_called()

    @patch.dict(os.environ, {"PLUR_INJECTION_FEEDBACK": "true"})
    def test_engrams_cleared_after_feedback(self):
        import plur_hermes
        bridge = self._make_bridge()
        with patch("plur_hermes.PlurBridge", return_value=bridge):
            ctx = self._make_ctx()
            plur_hermes.register(ctx)
            plur_hermes._session_state["s4"] = {
                "count": 0, "started": 0,
                "injected_ids": ["ENG-001"],
                "injected_engrams": [{"id": "ENG-001", "statement": "always use pnpm not npm"}],
            }

            ctx.hooks["post_llm_call"]("s4", "I will always use pnpm not npm.")

            assert plur_hermes._session_state["s4"]["injected_engrams"] == []
