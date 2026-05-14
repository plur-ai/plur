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


class TestSentenceFallback:
    """Strategy 3: sentence-level fallback when no explicit marker found."""

    def test_correction_prefix_sentence(self):
        text = "Let me fix that.\nCorrection: use pnpm not npm in this monorepo for all package operations."
        result = extract_learning_patterns(text)
        assert len(result) == 1
        assert "pnpm" in result[0]

    def test_the_correct_way_is(self):
        text = "I had it wrong. The correct way is to call pnpm build before running tests."
        result = extract_learning_patterns(text)
        assert len(result) == 1
        assert "pnpm build" in result[0]

    def test_the_best_way_to(self):
        text = "The best way to handle this is to use workspace:* for internal deps."
        result = extract_learning_patterns(text)
        assert len(result) == 1

    def test_i_should_sentence(self):
        text = "I should always run pnpm test before committing changes to the repo."
        result = extract_learning_patterns(text)
        assert len(result) == 1
        assert "pnpm test" in result[0]

    def test_i_must_sentence(self):
        text = "I must rebuild core before testing claw since claw imports from dist not source."
        result = extract_learning_patterns(text)
        assert len(result) == 1

    def test_we_should_sentence(self):
        text = "We should bump all nine version locations when releasing a new version."
        result = extract_learning_patterns(text)
        assert len(result) == 1

    def test_i_never_sentence(self):
        text = "I never use npm publish directly here — always authenticate as plur9 first."
        result = extract_learning_patterns(text)
        assert len(result) == 1

    def test_multiple_sentences(self):
        text = (
            "Looking back at my work.\n"
            "I should run pnpm build after changing core package files.\n"
            "I must use workspace:* for internal package dependencies always.\n"
        )
        result = extract_learning_patterns(text)
        assert len(result) == 2

    def test_marker_wins_over_sentence_fallback(self):
        # Alt marker present — sentence fallback must NOT run
        text = (
            "I learned:\n- Use pnpm not npm for workspace operations\n\n"
            "I should also rebuild core before claw tests every time."
        )
        result = extract_learning_patterns(text)
        assert len(result) == 1
        assert "pnpm not npm" in result[0]

    def test_short_sentences_excluded(self):
        # Sentence under 25 chars should not appear
        text = "I should fix it."
        result = extract_learning_patterns(text)
        assert result == []

    def test_plain_opinion_no_subject_not_matched(self):
        # "should" without I/We subject — must not match (keeps false-positive rate low)
        text = "This approach should work fine for the use case."
        result = extract_learning_patterns(text)
        assert result == []

    def test_correction_inline_not_matched(self):
        # "Correction:" not at line start — issue is indented flow, not standalone
        text = "After review (Correction: this is not what was meant) we proceed normally."
        result = extract_learning_patterns(text)
        assert result == []
