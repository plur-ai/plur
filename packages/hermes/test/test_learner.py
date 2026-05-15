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
    """Strategy 3: sentence-level extraction without markers."""

    # --- Self-corrections (0.9) ---

    def test_extracts_i_was_wrong(self):
        text = "I was wrong about the publish order. Core must be published first since mcp and claw depend on it via workspace:*."
        result = extract_learning_patterns(text)
        assert len(result) >= 1
        assert any("publish order" in r for r in result)

    def test_extracts_i_stand_corrected(self):
        text = "I stand corrected — the right approach is to call `pnpm build` in core before running integration tests, not to rely on the source TypeScript directly."
        result = extract_learning_patterns(text)
        assert len(result) == 1

    def test_extracts_i_was_mistaken(self):
        text = "I was mistaken: `tsup` does tree-shake ES module bundles by default. The flag to disable it is `--no-treeshake`."
        result = extract_learning_patterns(text)
        assert len(result) >= 1

    def test_extracts_actually_the(self):
        text = "Actually, the remote store API uses `/api/v1/engrams` not `/api/engrams`. I had the wrong path."
        result = extract_learning_patterns(text)
        assert len(result) >= 1
        assert any("/api/v1/engrams" in r for r in result)

    def test_extracts_correction_colon(self):
        text = "Correction: the `on_session_end` hook fires after the model's final message, not before. I had the lifecycle order wrong."
        result = extract_learning_patterns(text)
        assert len(result) >= 1

    def test_extracts_looking_more_carefully(self):
        text = "Looking at this more carefully, I see I had the engram decay formula backwards. Strength decays exponentially with time, not linearly."
        result = extract_learning_patterns(text)
        assert len(result) >= 1

    def test_extracts_i_had_backwards(self):
        text = "I had this backwards: `plur_forget` soft-deletes by marking `deleted: true`, it does not remove the YAML entry immediately."
        result = extract_learning_patterns(text)
        assert len(result) >= 1

    def test_extracts_i_now_know(self):
        text = "I now know that the `workspace:*` dependency is rewritten to the exact version on publish, not left as a range."
        result = extract_learning_patterns(text)
        assert len(result) == 1

    # --- Commitments/rules (0.8) ---

    def test_extracts_from_now_on(self):
        text = "From now on I will always verify day-of-week with python3 before writing org timestamps — I've gotten these wrong multiple times."
        result = extract_learning_patterns(text)
        assert len(result) == 1

    def test_extracts_i_should_never(self):
        text = "I should never run `--help` on the publish scripts here. The `flag in sys.argv` pattern treats unrecognized args as live-publish triggers."
        result = extract_learning_patterns(text)
        assert len(result) == 1

    def test_extracts_i_will_remember(self):
        text = "I will remember to check the stub server in `test/helpers/stub-server.ts` whenever adding a new remote store endpoint."
        result = extract_learning_patterns(text)
        assert len(result) == 1

    def test_extracts_you_should_always(self):
        text = "You should always use `pnpm` for this monorepo — yarn and npm don't resolve the workspace deps correctly."
        result = extract_learning_patterns(text)
        assert len(result) == 1

    def test_extracts_you_must_never(self):
        text = "You must never pass `--no-verify` to git commit here unless you've confirmed the pre-commit hooks are not needed."
        result = extract_learning_patterns(text)
        assert len(result) == 1

    def test_extracts_ill_make_sure(self):
        text = "I'll make sure to rebuild core with `pnpm --filter @plur-ai/core build` before running claw tests. Skipping this step causes stale-dist failures."
        result = extract_learning_patterns(text)
        assert len(result) >= 1

    # --- Factual corrections (0.7) ---

    def test_extracts_the_correct_way(self):
        text = "The correct way to run smoke tests against the production server is to set `PLUR_REMOTE_TEST_URL` and `PLUR_REMOTE_TEST_TOKEN`."
        result = extract_learning_patterns(text)
        assert len(result) == 1

    def test_extracts_after_checking(self):
        text = "After checking the source, the correct flag is `--access public`, not `--public`. The npm publish command silently ignores unrecognized flags."
        result = extract_learning_patterns(text)
        assert len(result) >= 1

    # --- Hypothetical rejection ---

    def test_rejects_hypothetical_if_we_were(self):
        text = "If we were to migrate to a relational database, we should never store engram text in a VARCHAR column."
        result = extract_learning_patterns(text)
        assert result == []

    def test_rejects_hypothetical_in_theory(self):
        text = "In theory, you could cache the BM25 index across sessions to improve recall latency."
        result = extract_learning_patterns(text)
        assert result == []

    def test_rejects_hypothetical_one_approach(self):
        text = "One approach would be to add versioning to the engram schema. We would then need migration tooling."
        result = extract_learning_patterns(text)
        assert result == []

    def test_rejects_hypothetical_were_we_to(self):
        text = "Were we to open-source the enterprise server, we would need to strip the billing module first."
        result = extract_learning_patterns(text)
        assert result == []

    # --- Reasoning rejection ---

    def test_rejects_reasoning_explanation(self):
        text = "Spreading activation works by propagating score from the query engrams to their neighbors in the knowledge graph."
        result = extract_learning_patterns(text)
        assert result == []

    def test_rejects_reasoning_bm25(self):
        text = "BM25 uses term frequency and inverse document frequency to score matches. TF saturation prevents long documents from dominating."
        result = extract_learning_patterns(text)
        assert result == []

    # --- Confidence threshold ---

    def test_min_confidence_filters_lower_tiers(self):
        text = "I was wrong about the recall limit. The correct way to set it is via the `limit` parameter."
        # 0.9 confidence: "I was wrong..."
        # 0.7 confidence: "The correct way..."
        high_only = extract_learning_patterns(text, min_confidence=0.9)
        all_matches = extract_learning_patterns(text, min_confidence=0.7)
        assert len(high_only) >= 1
        assert len(all_matches) >= len(high_only)

    # --- Edge cases ---

    def test_short_sentences_ignored(self):
        text = "I was wrong. Too short."
        result = extract_learning_patterns(text)
        assert result == []

    def test_strategies_1_2_still_take_precedence(self):
        text = "---\n\U0001f9e0 I learned:\n- Brain emoji takes priority over sentence fallback\n---\nI was wrong about something else entirely."
        result = extract_learning_patterns(text)
        assert len(result) == 1
        assert "Brain emoji" in result[0]


class TestCorpusValidation:
    """Validate against the labeled corpus."""

    def test_corpus_recall_and_precision(self):
        import json
        from pathlib import Path

        corpus_path = Path(__file__).parent / "fixtures" / "learning-corpus.jsonl"
        if not corpus_path.exists():
            pytest.skip("Corpus file not found")

        entries = [json.loads(line) for line in corpus_path.read_text().strip().split('\n')]

        true_positives = 0
        false_negatives = 0
        false_positives = 0
        total_learning_instruction = 0
        total_hypothetical_reasoning = 0

        for entry in entries:
            text = entry["turn_text"]
            labels = entry.get("labels", [])
            kinds = {l["kind"] for l in labels}

            result = extract_learning_patterns(text)

            if kinds & {"learning", "instruction"}:
                total_learning_instruction += 1
                if result:
                    true_positives += 1
                else:
                    false_negatives += 1
            elif kinds & {"hypothetical", "reasoning"}:
                total_hypothetical_reasoning += 1
                if result:
                    false_positives += 1

        recall = true_positives / total_learning_instruction if total_learning_instruction else 0
        fp_rate = false_positives / total_hypothetical_reasoning if total_hypothetical_reasoning else 0

        # Assert ≥80% recall on learning + instruction entries
        assert recall >= 0.80, f"Recall too low: {recall:.1%} ({true_positives}/{total_learning_instruction})"
        # Assert ≤15% false positive rate on hypothetical + reasoning
        assert fp_rate <= 0.15, f"False positive rate too high: {fp_rate:.1%} ({false_positives}/{total_hypothetical_reasoning})"
