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

    def test_extracts_plain_i_learned_marker(self):
        text = "Some response.\n\nI learned:\n- TypeScript tests need experimental flags\n- Always validate input at boundaries\n\nMoving on."
        result = extract_learning_patterns(text)
        assert len(result) == 2
        assert "TypeScript tests need experimental flags" in result

    def test_extracts_noted_marker(self):
        text = "Noted:\n- This is a valid learning statement worth keeping\n"
        result = extract_learning_patterns(text)
        assert result == ["This is a valid learning statement worth keeping"]

    def test_extracts_correction_noted_marker(self):
        text = "Looking again.\n\nCorrection noted:\n- Use pnpm not npm for this monorepo always\n"
        result = extract_learning_patterns(text)
        assert result == ["Use pnpm not npm for this monorepo always"]

    def test_extracts_key_takeaway_marker(self):
        text = "Key takeaway:\n- Workspace deps need explicit version bumps for publish\n"
        result = extract_learning_patterns(text)
        assert result == ["Workspace deps need explicit version bumps for publish"]

    def test_handles_numbered_bullets(self):
        text = "I learned:\n1. TypeScript tests need experimental flags\n2. Always validate input at boundaries\n"
        result = extract_learning_patterns(text)
        assert len(result) == 2

    def test_brain_block_wins_over_alt_marker(self):
        text = "---\n\U0001f9e0 I learned:\n- Fast path learning here please\n---\n\nI learned:\n- Alt path learning here please\n"
        result = extract_learning_patterns(text)
        assert any("Fast path" in r for r in result)
        assert not any("Alt path" in r for r in result)

    def test_alt_marker_only_matches_at_line_start(self):
        text = "The phrase I learned: appears inline but not at line start with body."
        result = extract_learning_patterns(text)
        assert result == []
