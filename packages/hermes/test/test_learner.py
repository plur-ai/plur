"""Tests for learning extraction."""

import pytest
from plur_hermes.learner import extract_learning_patterns


class TestExtractLearningPatterns:
    def test_extracts_brain_emoji_section(self):
        text = "Here is my response.\n\n---\n\U0001f9e0 I learned:\n- TypeScript tests need experimental flags\n- Always validate input at boundaries\n---"
        result = extract_learning_patterns(text)
        assert len(result) == 2
        assert "TypeScript tests need experimental flags" in result
        assert "Always validate input at boundaries" in result

    def test_ignores_short_lines(self):
        text = "---\n\U0001f9e0 I learned:\n- Short\n- This is a valid learning statement\n---"
        result = extract_learning_patterns(text)
        assert len(result) == 1
        assert "This is a valid learning statement" in result

    def test_returns_empty_when_no_section(self):
        text = "Just a normal response without any learning section."
        result = extract_learning_patterns(text)
        assert result == []

    def test_handles_bullet_variants(self):
        text = "---\n\U0001f9e0 I learned:\n- Dash bullet learning here\n\u2022 Dot bullet learning here\n* Star bullet learning here\n---"
        result = extract_learning_patterns(text)
        assert len(result) == 3

    def test_ignores_brain_emoji_in_normal_text(self):
        text = "The \U0001f9e0 I learned: section is important for memory."
        result = extract_learning_patterns(text)
        assert result == []

    def test_extracts_until_double_newline(self):
        text = "---\n\U0001f9e0 I learned:\n- First learning statement here\n- Second learning statement here\n\nNow continuing with other content."
        result = extract_learning_patterns(text)
        assert len(result) == 2
