"""Tests for learning extraction."""

import json
from pathlib import Path

import pytest
from plur_hermes.learner import extract_learning_patterns


def _texts(results: list[tuple[str, float]]) -> list[str]:
    return [text for text, _ in results]


def _confidences(results: list[tuple[str, float]]) -> list[float]:
    return [conf for _, conf in results]


class TestExtractLearningPatterns:
    def test_extracts_brain_emoji_section(self):
        text = "Here is my response.\n\n---\n\U0001f9e0 I learned:\n- TypeScript tests need experimental flags\n- Always validate input at boundaries\n---"
        result = extract_learning_patterns(text)
        assert len(result) == 2
        assert "TypeScript tests need experimental flags" in _texts(result)
        assert "Always validate input at boundaries" in _texts(result)
        assert all(c == 1.0 for c in _confidences(result))

    def test_ignores_short_lines(self):
        text = "---\n\U0001f9e0 I learned:\n- Short\n- This is a valid learning statement\n---"
        result = extract_learning_patterns(text)
        assert len(result) == 1
        assert "This is a valid learning statement" in _texts(result)

    def test_returns_empty_when_no_section(self):
        text = "Just a normal response without any learning section."
        result = extract_learning_patterns(text)
        assert result == []

    def test_handles_bullet_variants(self):
        text = "---\n\U0001f9e0 I learned:\n- Dash bullet learning here\n• Dot bullet learning here\n* Star bullet learning here\n---"
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
        assert "TypeScript tests need experimental flags" in _texts(result)
        assert all(c == 0.9 for c in _confidences(result))

    def test_extracts_noted_marker(self):
        text = "Noted:\n- This is a valid learning statement worth keeping\n"
        result = extract_learning_patterns(text)
        assert _texts(result) == ["This is a valid learning statement worth keeping"]

    def test_extracts_correction_noted_marker(self):
        text = "Looking again.\n\nCorrection noted:\n- Use pnpm not npm for this monorepo always\n"
        result = extract_learning_patterns(text)
        assert _texts(result) == ["Use pnpm not npm for this monorepo always"]

    def test_extracts_key_takeaway_marker(self):
        text = "Key takeaway:\n- Workspace deps need explicit version bumps for publish\n"
        result = extract_learning_patterns(text)
        assert _texts(result) == ["Workspace deps need explicit version bumps for publish"]

    def test_handles_numbered_bullets(self):
        text = "I learned:\n1. TypeScript tests need experimental flags\n2. Always validate input at boundaries\n"
        result = extract_learning_patterns(text)
        assert len(result) == 2

    def test_brain_block_wins_over_alt_marker(self):
        text = "---\n\U0001f9e0 I learned:\n- Fast path learning here please\n---\n\nI learned:\n- Alt path learning here please\n"
        result = extract_learning_patterns(text)
        assert any("Fast path" in r for r in _texts(result))
        assert not any("Alt path" in r for r in _texts(result))

    def test_alt_marker_only_matches_at_line_start(self):
        text = "The phrase I learned: appears inline but not at line start with body."
        result = extract_learning_patterns(text)
        assert result == []


class TestStrategy3:
    """Strategy 3: sentence-level learning extraction."""

    def test_self_correction_i_was_wrong(self):
        text = "I was wrong about the publish order. Core must be published first since mcp and claw depend on it."
        result = extract_learning_patterns(text)
        assert len(result) >= 1
        assert any("I was wrong" in t for t in _texts(result))
        assert all(c >= 0.7 for c in _confidences(result))

    def test_self_correction_i_was_mistaken(self):
        text = "I was mistaken: `tsup` does tree-shake ES module bundles by default."
        result = extract_learning_patterns(text)
        assert len(result) == 1
        assert _confidences(result)[0] == 0.85

    def test_self_correction_i_stand_corrected(self):
        text = "I stand corrected — the right approach is to call `pnpm build` in core before running integration tests."
        result = extract_learning_patterns(text)
        assert len(result) == 1

    def test_self_correction_i_had_this_backwards(self):
        text = "I had this backwards: `plur_forget` soft-deletes by marking `deleted: true`."
        result = extract_learning_patterns(text)
        assert len(result) == 1

    def test_correction_prefix(self):
        text = "Correction: the `on_session_end` hook fires after the model's final message, not before."
        result = extract_learning_patterns(text)
        assert len(result) == 1
        assert _confidences(result)[0] == 0.85

    def test_correction_prefix_not_confused_with_correction_noted(self):
        # "Correction noted:" is Strategy 2 (alt marker); "Correction:" is Strategy 3
        text = "Correction: the API path is wrong."
        result = extract_learning_patterns(text)
        texts = _texts(result)
        assert len(result) == 1
        assert texts[0].startswith("Correction:")

    def test_i_now_know(self):
        text = "I now know that the `workspace:*` dependency is rewritten to the exact version on publish."
        result = extract_learning_patterns(text)
        assert len(result) == 1

    def test_looking_at_this_more_carefully(self):
        text = "Looking at this more carefully, I see I had the engram decay formula backwards."
        result = extract_learning_patterns(text)
        assert len(result) >= 1

    def test_after_checking(self):
        text = "After checking the source, the correct flag is `--access public`, not `--public`."
        result = extract_learning_patterns(text)
        assert len(result) == 1
        assert _confidences(result)[0] == 0.80

    def test_the_correct_way(self):
        text = "The correct way to run smoke tests is to set all three env vars first."
        result = extract_learning_patterns(text)
        assert len(result) == 1

    def test_the_actual(self):
        text = "The actual return type of `plur_recall` is `EngramResult[]`, not `string[]`."
        result = extract_learning_patterns(text)
        assert len(result) == 1

    def test_from_now_on_i(self):
        text = "From now on I will always verify day-of-week with python3 before writing org timestamps."
        result = extract_learning_patterns(text)
        assert len(result) == 1

    def test_i_should_never(self):
        text = "I should never run `--help` on the publish scripts here."
        result = extract_learning_patterns(text)
        assert len(result) == 1

    def test_i_must_never(self):
        text = "I must never use `git checkout <branch> -- <path>` when there are unstaged changes."
        result = extract_learning_patterns(text)
        assert len(result) == 1

    def test_i_will_remember(self):
        text = "I will remember to check the stub server whenever adding a new remote store endpoint."
        result = extract_learning_patterns(text)
        assert len(result) == 1

    def test_ill_make_sure(self):
        text = "I'll make sure to rebuild core before running claw tests."
        result = extract_learning_patterns(text)
        assert len(result) == 1

    def test_does_not_fire_on_you_should(self):
        text = "You should always use `pnpm` for this monorepo."
        result = extract_learning_patterns(text)
        assert result == []

    def test_does_not_fire_on_we_should(self):
        text = "We should prefer RRF over weighted sum when the two distributions are different shapes."
        result = extract_learning_patterns(text)
        assert result == []

    def test_does_not_fire_on_hypothetical(self):
        text = "If we were to migrate to a relational database, we should never store engram text in a blob column."
        result = extract_learning_patterns(text)
        assert result == []

    def test_does_not_fire_on_factual_description(self):
        text = "BM25 uses term frequency and inverse document frequency to score matches."
        result = extract_learning_patterns(text)
        assert result == []

    def test_multi_sentence_extracts_matching_sentence_only(self):
        text = ("I had the ACL model backwards. Remote stores use scope-based access control, not per-engram ACL. "
                "If you need per-engram ACL, you should use separate scopes.")
        result = extract_learning_patterns(text)
        texts = _texts(result)
        assert any("I had the ACL model backwards" in t for t in texts)
        assert not any("you should use separate scopes" in t for t in texts)

    def test_strategy3_does_not_fire_when_s2_matches(self):
        text = "I learned:\n- Correction: the real rule applies here as a bullet\n"
        result = extract_learning_patterns(text)
        assert all(c == 0.9 for c in _confidences(result))


class TestCorpusFidelity:
    """Precision/recall measured against the labeled corpus fixture."""

    @classmethod
    def _load_corpus(cls) -> list[dict]:
        path = Path(__file__).parent / "fixtures" / "learning-corpus.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]

    def test_recall_on_s3_positive_turns(self):
        """S3 fires on turns with learning labels not caught by S1/S2."""
        corpus = self._load_corpus()
        # Entries 0-4 (turns 1-5) are S1/S2 targets with explicit block markers.
        # Remaining learning-labeled entries are S3 targets.
        s1s2_markers = ("---\n\U0001f9e0 I learned:", "I learned:\n", "Correction noted:\n",
                        "Key takeaway:\n", "Noted:\n")
        s3_targets = [
            e for e in corpus[5:]
            if any(l["kind"] == "learning" for l in e["labels"])
            and not any(e["turn_text"].startswith(m) or f"\n{m}" in e["turn_text"]
                        for m in s1s2_markers)
        ]
        assert s3_targets, "Expected S3 target turns in corpus"
        fired = sum(1 for e in s3_targets if extract_learning_patterns(e["turn_text"]))
        recall = fired / len(s3_targets)
        assert recall >= 0.50, f"Strategy 3 recall {recall:.0%} < 50% on {len(s3_targets)} S3 targets"

    def test_precision_on_negative_turns(self):
        """S3 does not fire on instruction/hypothetical/reasoning/unlabeled turns."""
        corpus = self._load_corpus()
        negative_turns = [e for e in corpus if not any(l["kind"] == "learning" for l in e["labels"])]
        assert negative_turns, "Expected negative turns in corpus"
        false_positives = sum(1 for e in negative_turns if extract_learning_patterns(e["turn_text"]))
        fp_rate = false_positives / len(negative_turns)
        assert fp_rate < 0.15, (
            f"Strategy 3 FP rate {fp_rate:.0%} >= 15% "
            f"({false_positives}/{len(negative_turns)} negative turns fired)"
        )
