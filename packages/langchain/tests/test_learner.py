"""Tests for learner.py — ported from plur-hermes tests."""
from plur_langchain.learner import extract_learning_patterns


def test_brain_emoji_block():
    text = "---\n🧠 I learned:\n- Use PUT not PATCH for full updates\n---"
    results = extract_learning_patterns(text)
    assert len(results) == 1
    assert "PUT" in results[0]


def test_i_learned_marker():
    text = "I learned:\n- Always validate inputs at the boundary\n\nOther stuff."
    results = extract_learning_patterns(text)
    assert any("validate" in r for r in results)


def test_self_correction_sentence():
    text = "I was wrong about the API style. Actually, the correct way is REST."
    results = extract_learning_patterns(text)
    assert len(results) > 0


def test_no_false_positives_from_reasoning():
    text = "BM25 uses term frequency and inverse document frequency for scoring."
    results = extract_learning_patterns(text)
    assert results == []


def test_empty_text():
    assert extract_learning_patterns("") == []
